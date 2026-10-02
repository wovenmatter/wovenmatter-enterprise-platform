import "fastify";
declare module "fastify" {
  interface FastifyContextConfig {
    safeReport?: boolean;
    internalInference?: boolean;
    libraryContent?: boolean;
    isolatedContent?: boolean;
  }
}
