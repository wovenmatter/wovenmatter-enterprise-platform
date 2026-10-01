import 'fastify';
declare module 'fastify' {
 interface FastifyContextConfig {
  internalInference?: boolean;
  libraryContent?: boolean;
  isolatedContent?: boolean;
 }
}
