export interface SourcePreview {
  totalLines: number;
  sections: Array<{ label: string; lines: Array<{ number: number; text: string }> }>;
}

// Local display only. These samples are never sent to AI or diagnostic logs.
export function sourcePreview(content: string): SourcePreview {
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const totalLines = lines.length;
  const range = (start: number, count: number) => lines.slice(start, start + count).map((text, index) => ({ number: start + index + 1, text: text.length > 500 ? text.slice(0, 500) + "..." : text }));
  if (totalLines <= 13) return { totalLines, sections: [{ label: "Source", lines: range(0, totalLines) }] };
  return { totalLines, sections: [
    { label: "First 5 lines", lines: range(0, 5) },
    { label: "Middle 5 lines", lines: range(Math.floor(totalLines / 2) - 2, 5) },
    { label: "Last 3 lines", lines: range(totalLines - 3, 3) }
  ] };
}
