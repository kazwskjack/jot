/** Build the volatile DSH Config schema for the Jot Host-owned policy entry. */
export function createHostPolicyConfig(z) {
  return z.object({
    bindings: z.array(z.object({
      gateway_id: z.string().required(),
      actor_id: z.string().required(),
      host_instance_id: z.string().required(),
      operation: z.string().required(),
      namespace: z.string().required(),
      epoch: z.number().step(1).min(1).required(),
      expires_at: z.number().required()
    })).default([]).volatile()
  });
}
