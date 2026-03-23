import { SignJWT, importPKCS8 } from "jose";

export async function createGitHubInstallationToken(input: {
  appId: string;
  installationId: string;
  privateKeyPem: string;
}): Promise<string> {
  const alg = "RS256";
  const key = await importPKCS8(input.privateKeyPem, alg);
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg })
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(input.appId)
    .sign(key);

  const response = await fetch(`https://api.github.com/app/installations/${input.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": "hosted-symphony-worker",
    },
  });

  if (!response.ok) {
    throw new Error(`github_installation_token_failed:${response.status}`);
  }

  const payload = (await response.json()) as { token?: string };
  if (!payload.token) {
    throw new Error("github_installation_token_missing");
  }

  return payload.token;
}
