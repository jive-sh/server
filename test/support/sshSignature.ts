import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A git commit signature built the way `ssh-keygen -Y sign` builds one over an SSH agent (PROTOCOL.sshsig), and
 * checked by the real `ssh-keygen -Y verify`, so a test proves `ssh:sign` answers exactly what an agent must.
 */

/** SSH's wire `string`: a uint32 big-endian length, then the bytes. */
export function sshString(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

export const text = (value: string) => new TextEncoder().encode(value);
export const concat = (...parts: ReadonlyArray<Uint8Array>) => Uint8Array.from(parts.flatMap((part) => [...part]));

/** The key blob in an OpenSSH public key line. */
export const keyBlobOf = (publicKey: string) => new Uint8Array(Buffer.from(publicKey.split(" ")[1]!, "base64"));

const NAMESPACE = text("git");

/** What `ssh-keygen -Y sign -n git` asks the agent to sign for `message`. */
export async function gitSignedData(message: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const messageHash = new Uint8Array(await crypto.subtle.digest("SHA-512", message));
  return concat(text("SSHSIG"), sshString(NAMESPACE), sshString(new Uint8Array()), sshString(text("sha512")), sshString(messageHash));
}

/** The agent's answer wrapped in the armored signature `ssh-keygen -Y sign` writes. */
function armoredGitSignature(input: { readonly publicKey: string; readonly signature: Uint8Array }): string {
  const armored = concat(
    text("SSHSIG"), Uint8Array.from([0, 0, 0, 1]), sshString(keyBlobOf(input.publicKey)), sshString(NAMESPACE),
    sshString(new Uint8Array()), sshString(text("sha512")), sshString(input.signature),
  );
  const lines = Buffer.from(armored).toString("base64").match(/.{1,70}/g)!;
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

export async function runInDirectory(input: { readonly directory: string; readonly command: ReadonlyArray<string>; readonly stdin?: Uint8Array }) {
  const child = Bun.spawn([...input.command], { cwd: input.directory, stdin: input.stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input.stdin !== undefined && typeof child.stdin !== "number" && child.stdin !== undefined) {
    child.stdin.write(input.stdin);
    child.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}${stderr}` };
}

/**
 * Writes the signature and an allowed-signers file for `publicKey` into `directory`, then runs `ssh-keygen -Y verify`
 * over `message` as git does. A pass prints `Good "git" signature for alex@jive.sh`.
 */
export async function verifyGitSignature(input: {
  readonly directory: string;
  readonly publicKey: string;
  readonly signature: Uint8Array;
  readonly message: Uint8Array;
}) {
  writeFileSync(resolve(input.directory, "commit.sig"), armoredGitSignature(input));
  writeFileSync(resolve(input.directory, "allowed_signers"), `alex@jive.sh ${input.publicKey.split(" ").slice(0, 2).join(" ")}\n`);
  return await runInDirectory({
    directory: input.directory,
    command: ["ssh-keygen", "-Y", "verify", "-f", "allowed_signers", "-I", "alex@jive.sh", "-n", "git", "-s", "commit.sig"],
    stdin: input.message,
  });
}
