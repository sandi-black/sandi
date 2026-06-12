import { Type } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
  listPoliciesFromRoots,
  readPolicyFromRoots,
} from "../context/policies";

const PolicyRefParam = Type.String({
  description:
    "Logical policy ref under config/policies, such as memory-ritual.md.",
});

export default function policyToolsExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "policy_list",
      label: "List Policies",
      description:
        "List Sandi operating policies available in the current runtime.",
      promptSnippet:
        "List policies when you need to see which operational instructions are available.",
      parameters: Type.Object({}),
      async execute() {
        const policies = await listPoliciesFromRoots(readPolicyRoots());
        return textResult(
          policies.length > 0
            ? policies
                .map((policy) => `${policy.ref}: ${policy.title}`)
                .join("\n")
            : "No policy files found.",
          { count: policies.length },
        );
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "policy_read",
      label: "Read Policy",
      description:
        "Read one Sandi operating policy by logical ref. This does not expose arbitrary filesystem access.",
      promptSnippet:
        "Read a policy when an operational norm may apply and the prompt only shows the policy index.",
      parameters: Type.Object({
        ref: PolicyRefParam,
      }),
      async execute(_toolCallId, params) {
        const content = await readPolicyFromRoots(
          readPolicyRoots(),
          params.ref,
        );
        return textResult(content, { ref: params.ref });
      },
    }),
  );
}

function readPolicyRoots(): string[] {
  const configDir = process.env["SANDI_CONFIG_DIR"]?.trim() || "./config";
  const dataDir = process.env["SANDI_DATA_DIR"]?.trim() || "./data";
  return uniquePolicyRoots([
    `${dataDir}/config/policies`,
    `${configDir}/policies`,
  ]);
}

function uniquePolicyRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const root of roots) {
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(root);
  }
  return result;
}

function textResult(
  text: string,
  details: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}
