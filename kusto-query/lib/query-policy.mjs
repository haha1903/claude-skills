export function checkQueryAccess(mgmt, text, role) {
  if (role !== "user") return;
  if (!mgmt) {
    // KQL goes to the query endpoint. Control commands require the checked management path.
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    if (/(?:^|;)\s*\./.test(withoutComments)) {
      throw new Error("Use --mgmt for permitted read-only schema commands.");
    }
    return;
  }
  const command = text.trim();
  const name = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*|\['[A-Za-z0-9_ .-]+'\])`;
  const listing = /^\.show\s+(?:databases|tables|functions|external\s+tables|materialized-views)$/i;
  const schema = new RegExp(String.raw`^\.show\s+(?:external\s+)?table\s+${name}\s+(?:schema\s+as\s+json|details)$`, "i");
  const fn = new RegExp(String.raw`^\.show\s+function\s+${name}$`, "i");
  if (!listing.test(command) && !schema.test(command) && !fn.test(command)) {
    throw new Error("Ordinary users may query Kusto and discover schemas, but cannot run this management command.");
  }
}
