/** Minimal server-rendered pages for setup and status. No client-side framework needed. */

export function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Tagged template that escapes interpolated values unless they are wrapped with `raw()`. */
export class RawHtml {
	constructor(readonly value: string) {}
	toString(): string {
		return this.value;
	}
}

export const raw = (value: string) => new RawHtml(value);

export function html(strings: TemplateStringsArray, ...values: unknown[]): RawHtml {
	let out = strings[0] ?? "";
	values.forEach((value, i) => {
		const rendered = Array.isArray(value)
			? value.map((item) => (item instanceof RawHtml ? item.value : escapeHtml(item))).join("")
			: value instanceof RawHtml
				? value.value
				: escapeHtml(value);
		out += rendered + (strings[i + 1] ?? "");
	});
	return new RawHtml(out);
}

const STYLES = `
:root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #c2410c; --card: #ffffff; --ok: #15803d; --bad: #b91c1c; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --accent: #fb923c; --card: #292524; --ok: #4ade80; --bad: #f87171; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
h2 { font-size: 1.1rem; margin: 32px 0 8px; }
p, li { color: var(--fg); }
.muted { color: var(--muted); }
a { color: var(--accent); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin: 12px 0; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.stat b { display: block; font-size: 1.4rem; font-variant-numeric: tabular-nums; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.ok { color: var(--ok); } .bad { color: var(--bad); }
label { display: block; margin: 8px 0 4px; font-weight: 600; }
input[type=text] { width: 100%; max-width: 360px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
button { margin-top: 12px; padding: 8px 14px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
`;

export function page(title: string, body: RawHtml, status = 200): Response {
	const document = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${raw(STYLES)}</style>
</head>
<body><main>${body}</main></body>
</html>`;
	return new Response(document.value, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action https://github.com 'self'",
			"Referrer-Policy": "no-referrer",
		},
	});
}
