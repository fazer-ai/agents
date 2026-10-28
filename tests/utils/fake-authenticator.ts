import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

// A software authenticator (ES256 through WebCrypto, "none" attestation) that speaks the whole
// protocol against the library's real verification, so a test proves the single-use challenge, the
// credential's owner and the session the sign-in issues, none of which a mocked library could show.

const b64 = (bytes: Uint8Array) =>
  isoBase64URL.fromBuffer(new Uint8Array(bytes));

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

const sha256 = async (data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));

function u32(n: number) {
  return new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

// WebCrypto signs ECDSA as r||s; WebAuthn carries DER.
function derSignature(raw: Uint8Array) {
  const integer = (v: Uint8Array) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let x = v.slice(i);
    if ((x[0] ?? 0) & 0x80) x = concat(new Uint8Array([0]), x);
    return concat(new Uint8Array([0x02, x.length]), x);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export async function fakeAuthenticator({
  rpId,
  origin,
  fixedCounter = false,
  credentialIdBytes = 16,
}: {
  rpId: string;
  origin: string;
  fixedCounter?: boolean;
  credentialIdBytes?: number;
}) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const credentialId = crypto.getRandomValues(
    new Uint8Array(credentialIdBytes),
  );
  const rpIdHash = await sha256(new TextEncoder().encode(rpId));
  let counter = 0;
  // The registration options' `user.id`, handed back as `userHandle` on sign-in, as a real passkey
  // does.
  let owner: string | undefined;

  return {
    id: b64(credentialId),
    async register(
      challenge: string,
      userHandle: string | undefined,
      {
        from = origin,
        userPresent = true,
        userVerified = true,
      }: { from?: string; userPresent?: boolean; userVerified?: boolean } = {},
    ) {
      owner = userHandle;
      const cose = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, isoBase64URL.toBuffer(jwk.x as string)],
          [-3, isoBase64URL.toBuffer(jwk.y as string)],
        ]),
      );
      const authData = concat(
        rpIdHash,
        // NOTE: a conditional create (Chrome's silent upgrade) reports neither.
        new Uint8Array([(userPresent ? UP : 0) | (userVerified ? UV : 0) | AT]),
        u32(counter),
        new Uint8Array(16),
        new Uint8Array([credentialId.length >> 8, credentialId.length & 255]),
        credentialId,
        cose,
      );
      const attestationObject = isoCBOR.encode(
        new Map<string, Parameters<typeof isoCBOR.encode>[0]>([
          ["fmt", "none"],
          ["attStmt", new Map<string, string>()],
          ["authData", authData],
        ]),
      );
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({
          type: "webauthn.create",
          challenge,
          origin: from,
          crossOrigin: false,
        }),
      );
      return {
        id: b64(credentialId),
        rawId: b64(credentialId),
        type: "public-key" as const,
        response: {
          clientDataJSON: b64(clientDataJSON),
          attestationObject: b64(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    async login(
      challenge: string,
      {
        from = origin,
        userHandle = owner,
        signWith = pair.privateKey,
        userVerified = true,
      }: {
        from?: string;
        userHandle?: string | null;
        signWith?: CryptoKey;
        userVerified?: boolean;
      } = {},
    ) {
      if (!fixedCounter) counter += 1;
      const authData = concat(
        rpIdHash,
        new Uint8Array([userVerified ? UP | UV : UP]),
        u32(counter),
      );
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({
          type: "webauthn.get",
          challenge,
          origin: from,
          crossOrigin: false,
        }),
      );
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          signWith,
          concat(authData, await sha256(clientDataJSON)),
        ),
      );
      return {
        id: b64(credentialId),
        rawId: b64(credentialId),
        type: "public-key" as const,
        response: {
          clientDataJSON: b64(clientDataJSON),
          authenticatorData: b64(authData),
          signature: b64(derSignature(signature)),
          ...(userHandle ? { userHandle } : {}),
        },
        clientExtensionResults: {},
      };
    },
  };
}
