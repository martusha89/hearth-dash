const isColor = process.stdout.isTTY && !process.env.NO_COLOR;
const fmt = (code) => (text) => isColor ? `\x1b[${code}m${text}\x1b[0m` : text;

export const bold = fmt("1");
export const dim = fmt("2");
export const red = fmt("31");
export const green = fmt("32");
export const yellow = fmt("33");
export const cyan = fmt("36");
export const magenta = fmt("35");

export function banner() {
  console.log(magenta(bold("\n  HEARTH DASH")));
  console.log(dim("  Personal dashboard\n"));
}

export function step(n, total, text) {
  console.log(cyan(`[${n}/${total}]`) + ` ${text}`);
}

export function success(text) { console.log(green("  \u2713 ") + text); }
export function warn(text) { console.log(yellow("  ! ") + text); }
export function fail(text) { console.log(red("  \u2717 ") + text); }
export function info(text) { console.log(dim("  \u2192 ") + text); }

const FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];

export function spinner(text) {
  if (!isColor) {
    process.stdout.write(`  ${text}...`);
    return { stop: (f) => console.log(` ${f || "done"}`), fail: (f) => console.log(` ${f || "failed"}`) };
  }
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r  ${cyan(FRAMES[i++ % FRAMES.length])} ${text}`);
  }, 80);
  return {
    stop(f) { clearInterval(id); process.stdout.write(`\r  ${green("\u2713")} ${f || text}\n`); },
    fail(f) { clearInterval(id); process.stdout.write(`\r  ${red("\u2717")} ${f || text}\n`); },
  };
}
