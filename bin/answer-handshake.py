#!/usr/bin/env python3
"""Handshake-answer pty wrapper for opencode inside herdr panes.

opencode/OpenTUI crashes at startup (EXC_BREAKPOINT in bufferDrawTextBufferView)
when the surrounding terminal answers its capability handshake only partially —
herdr panes reply to most queries but not OSC 10/11 (upstream: sst/opencode#41483).
The crash is deterministic: "herdr | everything except OSC 10/11 | CRASH".

This wrapper runs opencode inside a private pty, answers every capability
query xterm-style (foreground/background colors, cursor position, device
attributes, kitty keyboard/graphics), strips the queries from the outward
stream, and forwards everything else verbatim in both directions.

Usage: answer-handshake.py <command> [args...]
"""
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import tty
import fcntl

# Queries opencode sends at startup (captured in sst/opencode#41483):
#   ESC[?2031h          color scheme change notifications (no reply expected)
#   ESC]10;? BEL/ST     default foreground color query
#   ESC]11;? BEL/ST     default background color query
#   ESC[>0q             XTVERSION (terminal version) query
#   ESC[6n              cursor position report query
#   ESC P + q 4d73 ST   XTGETTCAP (kitty terminfo) query for "4d73" ("ms")
#   ESC[?1016$p         DECRQM: mouse SGR-pixels mode
#   ESC[?2027$p         DECRQM: rectangular editing mode
#   ESC[?2026$p         DECRQM: synchronized output mode

OSC_FG_REPLY = b"\x1b]10;rgb:eeeeee/eeeeee/eeeeee\x1b\\"
OSC_BG_REPLY = b"\x1b]11;rgb:0a0a0a/0a0a0a/0a0a0a\x1b\\"
XTVERSION_REPLY = b"\x1bP>|xterm(370)\x1b\\"
CPR_REPLY = b"\x1b[1;1R"  # cursor at row 1 col 1
XTGETTCAP_REPLY = b"\x1bP1+r4d73=01\x1b\\"  # "ms" capability = 0x01 (yes)
DECRQM_REPLY = {
    b"?1016": b"\x1b[?1016;2$y",  # mode set
    b"?2027": b"\x1b[?2027;2$y",
    b"?2026": b"\x1b[?2026;2$y",
}

QUERY_PATTERNS = [
    (re.compile(rb"\x1b\]10;\?(\x07|\x1b\\)"), b""),
    (re.compile(rb"\x1b\]11;\?(\x07|\x1b\\)"), b""),
    (re.compile(rb"\x1b\[>0q"), b""),
    (re.compile(rb"\x1b\[6n"), b""),
    (re.compile(rb"\x1bP\+q[0-9a-fA-F]+(\x1b\\|\x07)"), b""),
    (re.compile(rb"\x1b\[\?\d+\$p"), b""),
]


def strip_and_collect(data: bytes):
    """Remove query sequences from outward stream; return (clean, answers)."""
    answers = []
    if b"\x1b]10;?" in data:
        answers.append(OSC_FG_REPLY)
    if b"\x1b]11;?" in data:
        answers.append(OSC_BG_REPLY)
    if b"\x1b[>0q" in data:
        answers.append(XTVERSION_REPLY)
    if b"\x1b[6n" in data:
        answers.append(CPR_REPLY)
    if b"\x1bP+q" in data:
        answers.append(XTGETTCAP_REPLY)
    for pat, dec in DECRQM_REPLY.items():
        if b"\x1b[?" + pat[1:] + b"$p" in data:
            answers.append(dec)
    clean = data
    for pat, _ in QUERY_PATTERNS:
        clean = pat.sub(b"", clean)
    return clean, answers


def main():
    if len(sys.argv) < 2:
        print("usage: answer-handshake.py <command> [args...]", file=sys.stderr)
        sys.exit(1)

    slave_fd, master_fd = pty.openpty()

    # propagate the current pane size
    try:
        sz = fcntl.ioctl(0, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, sz)
    except OSError:
        pass

    proc = subprocess.Popen(
        sys.argv[1:],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
    )
    os.close(slave_fd)

    old_term = None
    try:
        old_term = termios.tcgetattr(0)
        tty.setraw(0)
    except termios.error:
        old_term = None  # no controlling tty (piped) — run forward-only

    try:
        while True:
            rlist = []
            if proc.poll() is None:
                rlist.append(master_fd)
            if old_term is not None:
                rlist.append(0)
            if not rlist:
                # piped mode: no stdin; wait for the child
                import time
                time.sleep(0.2)
                if proc.poll() is not None:
                    break
                continue
            ready, _, _ = select.select(rlist, [], [], 1.0)

            for fd in ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    continue
                if fd == master_fd:
                    # agent -> terminal: strip queries, inject full answers
                    clean, answers = strip_and_collect(data)
                    if clean:
                        os.write(1, clean)
                    for a in answers:
                        os.write(master_fd, a)
                else:
                    os.write(master_fd, data)

            if proc.poll() is not None:
                # drain remaining output
                try:
                    while True:
                        r, _, _ = select.select([master_fd], [], [], 0.05)
                        if not r:
                            break
                        data = os.read(master_fd, 65536)
                        if not data:
                            break
                        clean, answers = strip_and_collect(data)
                        if clean:
                            os.write(1, clean)
                        for a in answers:
                            os.write(master_fd, a)
                except OSError:
                    pass
                break
    finally:
        if old_term is not None:
            termios.tcsetattr(0, termios.TCSADRAIN, old_term)
        try:
            proc.wait(timeout=2)
        except Exception:
            proc.kill()

    sys.exit(proc.returncode or 0)


if __name__ == "__main__":
    main()