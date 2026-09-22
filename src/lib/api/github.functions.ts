import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { inspectGitHubRepository, verifyFirebaseIdToken } from "../github-repo.server";

export const inspectGitHubRepo = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    urlOrSlug: z.string().min(1),
    subpath: z.string().optional(),
    idToken: z.string().min(1, "Firebase ID token is required for server authentication."),
  }))
  .handler(async ({ data }) => {
    // Cryptographically verify caller's Firebase ID token on the server
    const authResult = await verifyFirebaseIdToken(data.idToken);
    if (!authResult.valid) {
      return {
        success: false,
        errorType: "inaccessible",
        errorReason: `Server Authentication Failure: ${authResult.reason}`,
      };
    }

    // Call privileged server inspection using server-only GITHUB_TOKEN
    return await inspectGitHubRepository(data.urlOrSlug, data.subpath);
  });

