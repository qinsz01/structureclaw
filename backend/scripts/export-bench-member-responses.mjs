// Explicit offline derivation. Does not run solvers or rewrite frozen reference files.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { recoverMemberResponses } from "../dist/skill-shared/member-response.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const corpus = path.resolve(
  process.argv[2] ?? path.join(root, "tests/llm-benchmark"),
);
const read = (relative) =>
  JSON.parse(fs.readFileSync(path.join(corpus, relative), "utf8"));
const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const models = read("fixtures/ground-truth-models.json");
const numerical = read("fixtures/opensees-ground-truth.json");
const entries = {};
for (const reference of models) {
  const source = numerical.models.find((item) => item.modelId === reference.id);
  if (!source) continue;
  const snapshot = JSON.stringify({
    model: reference.model,
    result: source.result,
    factors: source.analysisSelection?.factors,
  });
  entries[reference.id] = {
    inputSha256: sha256(snapshot),
    responses: recoverMemberResponses(
      reference.model,
      source.result,
      source.analysisSelection?.factors,
      "opensees",
    ),
  };
}
const output = path.join(corpus, "viewer/derived/member-responses.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(
  output,
  JSON.stringify({
    schemaVersion: 1,
    algorithm: {
      name: "StructureClaw member response recovery",
      version: 1,
      source: "backend/src/skill-shared/member-response.ts",
      sha256: sha256(
        fs.readFileSync(
          path.join(root, "backend/src/skill-shared/member-response.ts"),
        ),
      ),
    },
    sources: [
      "fixtures/ground-truth-models.json",
      "fixtures/opensees-ground-truth.json",
    ].map((source) => ({
      source,
      sha256: sha256(fs.readFileSync(path.join(corpus, source))),
    })),
    entries,
  }),
);
console.log(
  `Derived ${Object.keys(entries).length} member-response datasets: ${output}`,
);
