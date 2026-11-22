/**
 * Regenerate the TypeScript and Kotlin clients from `proxy/openapi.yaml`.
 *
 * Run from the repository root with `bun run api:generate`.
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const spec = join(root, "proxy/openapi.yaml");
const tsOutput = join(root, "packages/proxy-client/src/schema.d.ts");
const androidPackage = join(root, "android/proxy-client/src/main/java/dev/remagnet/proxy");
const openapiTypescript = join(root, "node_modules/.bin/openapi-typescript");
const openapiGenerator = join(root, "node_modules/.bin/openapi-generator-cli");

console.log("Generating TypeScript client from proxy/openapi.yaml");
await $`${openapiTypescript} ${spec} -o ${tsOutput}`.cwd(root);

console.log("Generating Kotlin client from proxy/openapi.yaml");
const output = await mkdtemp(join(tmpdir(), "remagnet-openapi-"));
try {
  await $`${openapiGenerator} generate \
    -i ${spec} \
    -g kotlin \
    -o ${output} \
    --library=jvm-retrofit2 \
    --additional-properties=serializationLibrary=gson,useCoroutines=true,dateLibrary=java8,sourceFolder=src/main/java,packageName=dev.remagnet.proxy \
    --global-property=apis,models,supportingFiles,apiDocs=false,modelDocs=false,apiTests=false,modelTests=false`
    .cwd(root)
    .quiet();

  await rm(androidPackage, { recursive: true, force: true });
  await cp(join(output, "src/main/java/dev/remagnet/proxy"), androidPackage, { recursive: true });
  await makeArchiveStreaming(androidPackage);
  console.log(`Wrote ${androidPackage}`);
} finally {
  await rm(output, { recursive: true, force: true });
}

/**
 * OpenAPI Generator returns a `ResponseBody` for binary responses but omits
 * Retrofit's `@Streaming`, which makes Retrofit buffer the whole body. ZIPs can
 * be many gigabytes, so keep the archive response streaming.
 */
async function makeArchiveStreaming(packageDir: string): Promise<void> {
  const file = join(packageDir, "apis/ArchivesApi.kt");
  const annotation = '    @GET("archive/{hash}")';
  const source = await Bun.file(file).text();
  if (!source.includes(annotation)) {
    throw new Error(`Could not find the archive endpoint in ${file}`);
  }
  if (source.includes("@Streaming")) return;

  await Bun.write(
    file,
    source.replace(
      annotation,
      `    // Keep large ZIP downloads out of memory.\n    @Streaming\n${annotation}`,
    ),
  );
}
