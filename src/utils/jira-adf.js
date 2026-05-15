/**
 * Convert plain text to Atlassian Document Format (required for Jira Cloud description).
 */
export function plainTextToAdf(text) {
  if (!text || !String(text).trim()) return undefined;

  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  return {
    type: "doc",
    version: 1,
    content: paragraphs.map((para) => ({
      type: "paragraph",
      content: [{ type: "text", text: para.slice(0, 32767) }],
    })),
  };
}
