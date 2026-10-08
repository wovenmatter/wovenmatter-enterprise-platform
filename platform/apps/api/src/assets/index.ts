import type { FastifyInstance } from "fastify";
import { objectBody, type AppContext } from "../context.js";
import type { AssetAgentService } from "./service.js";
import type { InferenceService } from "../inference/service.js";
export async function registerAssetAgents(
  app: FastifyInstance,
  ctx: AppContext,
  service: AssetAgentService,
  inference: InferenceService,
) {
  app.get<{ Params: { assetId: string } }>(
    "/enterprise/api/assets/:assetId/agent",
    async (r) => service.detail(await ctx.requireUser(r), r.params.assetId),
  );
  app.post<{ Params: { assetId: string } }>(
    "/enterprise/api/assets/:assetId/agent",
    async (r) => {
      const user = await ctx.requireUser(r),
        b = objectBody(r.body);
      await service.require(user, r.params.assetId);
      return service.conversations().createAsset(user, r.params.assetId, b);
    },
  );
  app.put<{ Params: { assetId: string } }>(
    "/enterprise/api/assets/:assetId/sources",
    async (r) =>
      service.setSources(
        await ctx.requireUser(r),
        r.params.assetId,
        objectBody(r.body).fileIds,
      ),
  );
  app.post<{ Params: { projectId: string } }>(
    "/enterprise/api/runtime/inference/:projectId/asset",
    { config: { internalInference: true }, bodyLimit: 300 * 1024 },
    async (r) => {
      const auth = r.headers.authorization,
        token =
          typeof auth === "string" && auth.startsWith("Bearer ")
            ? auth.slice(7)
            : "";
      const scope = await inference.authorizeGateway(r.params.projectId, token);
      return service.operation(scope, r.body);
    },
  );
}
