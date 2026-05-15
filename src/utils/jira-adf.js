import { config } from "../../config/migration.config.js";

function attachmentContentUrl(attachmentId) {
  const base = config.xray.jiraBaseUrl.replace(/\/$/, "");
  return `${base}/rest/api/3/attachment/content/${attachmentId}`;
}

/**
 * Build Atlassian Document Format for Jira Cloud description updates.
 * Embeds issue images via external media URLs (file-type media IDs fail validation).
 * @param {string} text
 * @param {Record<string, string>} filenameToAttachmentId  uploaded filename → Jira attachment id
 */
export function descriptionToAdf(text, filenameToAttachmentId = {}) {
  if (!text || !String(text).trim()) return undefined;

  const content = [];
  const blocks = String(text).split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    for (const line of lines) {
      const heading = line.match(/^\*([^*]+)\*$/);
      if (heading) {
        content.push({
          type: "paragraph",
          content: [{ type: "text", text: heading[1].trim(), marks: [{ type: "strong" }] }],
        });
        continue;
      }

      const embed = line.match(/^!([^|!]+)(?:\|[^!]*)?!$/);
      if (embed) {
        const attId = filenameToAttachmentId[embed[1].trim()];
        if (attId) {
          content.push(mediaSingleExternal(attId));
          continue;
        }
      }

      const nodes = parseInline(line, filenameToAttachmentId);
      if (nodes.length > 0) {
        content.push({ type: "paragraph", content: nodes });
      }
    }
  }

  if (content.length === 0) return undefined;

  return { type: "doc", version: 1, content };
}

function mediaSingleExternal(attachmentId) {
  return {
    type: "mediaSingle",
    attrs: { layout: "align-start" },
    content: [
      {
        type: "media",
        attrs: {
          type: "external",
          url: attachmentContentUrl(attachmentId),
        },
      },
    ],
  };
}

function parseInline(line, filenameToAttachmentId) {
  const nodes = [];
  const re =
    /!\[([^\]]*)\]\(([^)]+)\)|!([^|!]+)(?:\|[^!]*)?!|\[([^\]|]+)\|([^\]]+)\]|\*([^*]+)\*|([^*!\[]+)/g;

  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[1] !== undefined && m[2]) {
      nodes.push(linkNode(m[1] || m[2], m[2]));
    } else if (m[3]) {
      const fn = m[3].trim();
      const attId = filenameToAttachmentId[fn];
      if (attId) {
        nodes.push({
          type: "text",
          text: fn,
          marks: [{ type: "link", attrs: { href: attachmentContentUrl(attId) } }],
        });
      } else {
        nodes.push(textNode(fn));
      }
    } else if (m[4] && m[5]) {
      nodes.push(linkNode(m[4], m[5]));
    } else if (m[6]) {
      nodes.push({ type: "text", text: m[6], marks: [{ type: "strong" }] });
    } else if (m[7]) {
      nodes.push(textNode(m[7]));
    }
  }

  if (nodes.length === 0) nodes.push(textNode(line));
  return nodes;
}

function textNode(text) {
  return { type: "text", text: String(text).slice(0, 32767) };
}

function linkNode(label, href) {
  return {
    type: "text",
    text: label.slice(0, 32767),
    marks: [{ type: "link", attrs: { href } }],
  };
}

/** @deprecated use descriptionToAdf */
export function plainTextToAdf(text) {
  return descriptionToAdf(text);
}
