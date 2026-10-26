// Makes the VAPID key pair the push function signs with. Run once:
//   node supabase/functions/push/make-keys.mjs
// and put the two lines it prints into the function's secrets (supabase/PUSH.md).
// Keep the private key secret. A new pair later means every iPhone has to
// subscribe again (the app does that by itself the next time it opens).
import { createECDH } from "node:crypto";

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const b64url = (buf) => buf.toString("base64url");
console.log(`VAPID_PUBLIC_KEY=${b64url(ecdh.getPublicKey())}`);
const priv = ecdh.getPrivateKey();
console.log(`VAPID_PRIVATE_KEY=${b64url(Buffer.concat([Buffer.alloc(32 - priv.length), priv]))}`);
