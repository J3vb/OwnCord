import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  publicEncrypt,
  privateDecrypt,
  randomBytes,
  createHash,
} from "node:crypto";

// Detailed findings stay encrypted in the App-owned ledger. The environment's
// App key is held only by the trusted controller, never its model subprocesses.
export function sealEvidence(value, privateKey) {
  if (!privateKey) return undefined;
  const plain = Buffer.from(JSON.stringify(value));
  if (plain.length > 24_000) throw new Error("Review evidence exceeds ledger limit");
  const key = randomBytes(32),
    nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    version: 1,
    key: publicEncrypt({ key: createPublicKey(privateKey), oaepHash: "sha256" }, key).toString(
      "base64",
    ),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}
export function openEvidence(envelope, privateKey) {
  if (!envelope) return null;
  if (!privateKey || envelope.version !== 1) throw new Error("Cannot read prior review evidence");
  const key = privateDecrypt(
    { key: privateKey, oaepHash: "sha256" },
    Buffer.from(envelope.key, "base64"),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8"),
  );
}
export function carriedFindings(evidence) {
  const reviews = evidence?.reviews ?? [];
  const unresolved = (evidence?.findings ?? []).filter(
    (f) =>
      !reviews.length ||
      reviews.some(
        (r) =>
          !(r.finding_dispositions ?? []).some(
            (d) => d.id === f.id && ["resolved", "rejected"].includes(d.status),
          ),
      ),
  );
  return [
    ...unresolved,
    ...reviews.flatMap((r) =>
      r.findings
        .filter((f) => f.severity === "blocking")
        .map((f) => ({
          ...f,
          id: `claude:${createHash("sha256").update(`${f.path}\n${f.description}`).digest("hex")}`,
        })),
    ),
  ];
}
