import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { inspectGitHubRepository, verifyFirebaseIdToken } from "../github-repo.server";

export const inspectGitHubRepo = createServerFn({ method: "POST" })
  .inputValidator(z.object({
    urlOrSlug: z.string().min(1),
    subpath: z.string().optional(),
    idToken: z.string().optional(),
  }))
  .handler(async ({ data }) => {
    // If Firebase ID token is provided, verify it server-side
    if (data.idToken) {
      const authResult = await verifyFirebaseIdToken(data.idToken);
      if (!authResult.valid) {
        // Log verification failure for diagnostics if token was passed
        console.warn(`[github-repo] Firebase ID token verification warning: ${authResult.reason}`);
      }
    }

    // Inspect public repository using server-side inspection
    return await inspectGitHubRepository(data.urlOrSlug, data.subpath);
  });

