const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);

    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }

    throw new Error(`${label} is not JSON.`);
  }
}

function truncate(value, max = 2500) {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}

function quote(value, max = 2500) {
  return truncate(value || "(no body)", max)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function isTrustedAssociation(value) {
  return TRUSTED_ASSOCIATIONS.has(value);
}

module.exports = { isTrustedAssociation, parseJson, quote, truncate };
