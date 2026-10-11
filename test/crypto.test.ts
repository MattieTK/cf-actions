import { createPrivateKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	base64ToBytes,
	createAppJwt,
	decryptString,
	deriveEncryptionKey,
	encryptString,
	importRsaPrivateKey,
	pkcs1ToPkcs8,
	verifyWebhookSignature,
} from "../src/crypto";

describe("verifyWebhookSignature", () => {
	// Test vector from GitHub's "Validating webhook deliveries" documentation.
	const secret = "It's a Secret to Everybody";
	const body = "Hello, World!";
	const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

	it("accepts GitHub's documented example", async () => {
		expect(await verifyWebhookSignature(secret, body, signature)).toBe(true);
	});

	it("rejects tampered bodies, wrong secrets and malformed headers", async () => {
		expect(await verifyWebhookSignature(secret, `${body}!`, signature)).toBe(false);
		expect(await verifyWebhookSignature("other", body, signature)).toBe(false);
		expect(await verifyWebhookSignature(secret, body, signature.replace("sha256=", "sha1="))).toBe(false);
		expect(await verifyWebhookSignature(secret, body, null)).toBe(false);
		expect(await verifyWebhookSignature("", body, signature)).toBe(false);
	});
});

describe("GitHub App JWT", () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});

	it("converts PKCS#1 to the same PKCS#8 encoding Node produces", () => {
		const pkcs1 = base64ToBytes(privateKey.replace(/-----[^-]+-----|\s+/g, ""));
		const expected = createPrivateKey(privateKey).export({ type: "pkcs8", format: "der" });
		expect(Buffer.from(pkcs1ToPkcs8(pkcs1)).equals(expected)).toBe(true);
	});

	it("signs an RS256 JWT that verifies with the public key", async () => {
		const key = await importRsaPrivateKey(privateKey);
		const now = 1_760_000_000_000;
		const jwt = await createAppJwt(12345, key, now);
		const [header, claims, signature] = jwt.split(".");

		const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
		expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
		expect(decode(claims!)).toEqual({ iat: 1_760_000_000 - 60, exp: 1_760_000_000 + 540, iss: 12345 });

		const valid = verify(
			"RSA-SHA256",
			Buffer.from(`${header}.${claims}`),
			publicKey,
			Buffer.from(signature!, "base64url"),
		);
		expect(valid).toBe(true);
	});

	it("also accepts PKCS#8 keys", async () => {
		const { privateKey: pkcs8 } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
			publicKeyEncoding: { type: "spki", format: "pem" },
		});
		await expect(importRsaPrivateKey(pkcs8)).resolves.toBeDefined();
	});

	it("rejects things that are not keys", async () => {
		await expect(importRsaPrivateKey("not a key")).rejects.toThrow("Not a PEM-encoded key");
	});
});

describe("encryption at rest", () => {
	it("round-trips and uses a fresh IV each time", async () => {
		const key = await deriveEncryptionKey("operator secret");
		const a = await encryptString(key, "private key material");
		const b = await encryptString(key, "private key material");
		expect(a).not.toBe(b);
		expect(await decryptString(key, a)).toBe("private key material");
	});

	it("fails to decrypt with a different key", async () => {
		const token = await encryptString(await deriveEncryptionKey("one"), "secret");
		await expect(decryptString(await deriveEncryptionKey("two"), token)).rejects.toThrow();
	});

	it("refuses an empty secret", async () => {
		await expect(deriveEncryptionKey("")).rejects.toThrow("ENCRYPTION_KEY is not set");
	});
});
