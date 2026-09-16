import * as readline from "node:readline";

// choose.ts — arrow-key prompt, serf-style. Minimal, no dependency.

export interface Choice<T = string> {
  label: string;
  value: T;
  hint?: string;
}

export async function choose<T = string>(question: string, choices: Choice<T>[]): Promise<T> {
  if (choices.length === 0) throw new Error("no choices");
  if (choices.length === 1) return choices[0].value;

  const input = process.stdin as any;
  const rl = readline.createInterface({ input, output: process.stdout, terminal: true });
  if (typeof input.setRawMode !== "function") {
    // Non-TTY fallback: print options, return default
    rl.close();
    console.log(`${question} ${choices[0].label}`);
    return choices[0].value;
  }
  input.setRawMode(true);

  let selected = 0;
  const render = () => {
    const lines: string[] = [`  ${question}`];
    choices.forEach((c, i) => {
      const pointer = i === selected ? "❯" : " ";
      const dim = i === selected ? "\x1b[1m" : "\x1b[2m";
      lines.push(`  ${pointer} ${dim}${c.label}\x1b[0m${c.hint ? ` \x1b[2m${c.hint}\x1b[0m` : ""}`);
    });
    if ((render as any).once) {
      process.stdout.write(`\x1b[${choices.length + 1}A\r\x1b[J`);
    }
    (render as any).once = true;
    console.log(lines.join("\n"));
  };
  (render as any).once = false;

  console.log();
  render();

  return new Promise<T>((resolve) => {
    const onKey = (ch: string, key: { name: string }) => {
      if (key.name === "up" && selected > 0) { selected -= 1; render(); }
      else if (key.name === "down" && selected < choices.length - 1) { selected += 1; render(); }
      else if (key.name === "return") {
        input.off("keypress", onKey);
        input.setRawMode(false);
        rl.close();
        process.stdout.write("\x1b[" + (choices.length - selected) + "B\r\n");
        resolve(choices[selected].value);
      }
    };
    input.on("keypress", onKey);
  });
}