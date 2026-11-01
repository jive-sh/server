import friendlyWords from "friendly-words";

/**
 * An account's handle: three words (adjective, adjective, noun) drawn from the leading bytes of its WebAuthn
 * user id, the derivation @jive-sh/app used and ozy-cli uses for passkey credential ids (11, 11 and 12 bit
 * windows over bytes 0 to 4, modulo the word lists). Not unique by itself; registration draws another id when a
 * handle is taken.
 */
export function usernameFor(webAuthnUserId: string): string {
  const hex = webAuthnUserId.replaceAll("-", "");
  const [b0, b1, b2, b3, b4] = Array.from({ length: 5 }, (_unused, index) => {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    return Number.isNaN(byte) ? 0 : byte;
  }) as [number, number, number, number, number];
  const { predicates, objects } = friendlyWords;
  return [
    predicates[((b0 << 3) | (b1 >> 5)) % predicates.length],
    predicates[(((b1 & 0x1f) << 6) | (b2 >> 2)) % predicates.length],
    objects[(((b2 & 0x3) << 10) | (b3 << 2) | (b4 >> 6)) % objects.length],
  ].join("-");
}
