import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { ApiError } from "./schema";

const GOOGLE_KEYS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), {
  timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 300000,
});

export type GoogleIdentity = { subject: string; email: string; expiresAt: number };

export async function verifyGoogleIdentity(request: Request, clientId: string): Promise<GoogleIdentity> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization);
  if (!match || match[1]!.length > 12000) throw new ApiError(401, "SIGN_IN_REQUIRED");
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(match[1]!, GOOGLE_KEYS, {
      algorithms: ["RS256"], audience: clientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      requiredClaims: ["sub", "email", "email_verified", "exp", "iat"],
      maxTokenAge: "2h", clockTolerance: 30,
    }));
  } catch {
    // Never return/log the token, decoded untrusted payload, or library error.
    throw new ApiError(401, "INVALID_GOOGLE_TOKEN");
  }
  if (payload.aud !== clientId || (payload.azp !== undefined && payload.azp !== clientId) ||
      typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255 ||
      payload.email_verified !== true || typeof payload.email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    throw new ApiError(401, "INVALID_GOOGLE_TOKEN");
  }
  const email = payload.email.toLowerCase();
  // Google is authoritative for Gmail and Google Workspace email. Other Google
  // Account email providers need an additional policy/challenge before admission.
  if (!email.endsWith("@gmail.com") && !(typeof payload.hd === "string" && payload.hd.length > 0)) {
    throw new ApiError(403, "EMAIL_PROVIDER_NOT_SUPPORTED");
  }
  return { subject: payload.sub, email, expiresAt: payload.exp! };
}
