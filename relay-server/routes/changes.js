"use strict";

const queries = require("../db/queries");

/**
 * GET /changes?session_id=s-1
 */
async function changesRoutes(fastify, opts) {
  fastify.get(
    "/changes",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["session_id"],
          properties: {
            session_id: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const changes = queries.getFileChanges(request.query.session_id);
      return reply.send({ changes });
    },
  );
}

module.exports = changesRoutes;
