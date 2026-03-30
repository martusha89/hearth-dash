import { createInterface } from "node:readline";

function rl() { return createInterface({ input: process.stdin, output: process.stdout }); }

export function ask(question, defaultValue) {
  return new Promise((resolve) => {
    const r = rl();
    const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    r.question(prompt, (a) => { r.close(); resolve(a.trim() || defaultValue || ""); });
  });
}

export function confirm(question) {
  return new Promise((resolve) => {
    const r = rl();
    r.question(`${question} (y/N): `, (a) => { r.close(); resolve(a.trim().toLowerCase() === "y"); });
  });
}

export function password(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(`${question}: `);
    if (!stdin.isTTY || !stdin.setRawMode) {
      const r = rl();
      r.question("", (a) => { r.close(); resolve(a.trim()); });
      return;
    }
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let input = "";
    const onData = (buf) => {
      const ch = buf.toString("utf8");
      if (ch === "\r" || ch === "\n") {
        stdin.setRawMode(wasRaw || false); stdin.removeListener("data", onData); stdin.pause();
        process.stdout.write("\n"); resolve(input.trim());
      } else if (ch === "\u0003") { stdin.setRawMode(wasRaw || false); process.exit(1); }
      else if (ch === "\u007f" || ch === "\b") { if (input.length) { input = input.slice(0, -1); process.stdout.write("\b \b"); } }
      else if (ch.charCodeAt(0) >= 32) { input += ch; process.stdout.write("*"); }
    };
    stdin.on("data", onData);
  });
}
