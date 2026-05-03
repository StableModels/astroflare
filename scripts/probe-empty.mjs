// Probe emptyR2Bucket against a manually-created bucket
import { makeCloudflareClient } from "../packages/astroflare-cli-lib/src/api.ts";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const bucket = process.argv[2];
if (!bucket) {
	console.error("usage: node probe-empty.mjs <bucket>");
	process.exit(1);
}
const client = makeCloudflareClient({ accountId, apiToken });

console.log("listing before...");
// Inspect the response shape directly:
const lr = await fetch(
	`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`,
	{ headers: { Authorization: `Bearer ${apiToken}` } },
);
const json = await lr.json();
console.log("list result keys:", Object.keys(json));
console.log(
	"result:",
	Array.isArray(json.result) ? `array len ${json.result.length}` : typeof json.result,
);
console.log("result_info:", json.result_info);

console.log("calling emptyR2Bucket...");
await client.emptyR2Bucket(bucket);
console.log("done");

const lr2 = await fetch(
	`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`,
	{ headers: { Authorization: `Bearer ${apiToken}` } },
);
const j2 = await lr2.json();
console.log("after:", Array.isArray(j2.result) ? `len ${j2.result.length}` : j2.result);
