# 🌐 TinyFish — Public Web Intelligence for Houdry Agent

**TinyFish extends Houdry Agent beyond private model knowledge by bringing live public-web research directly into the DeepSeek Harness workflow.**

Houdry brings together agent orchestration, distributed private inference, and external information retrieval in one workflow. TinyFish plays a key role by enabling the agent to research public websites, retrieve current information, and gather evidence that can be analyzed by its configured models.

Rather than treating web research as a separate activity, the integration makes it part of the agent's broader problem-solving process. DeepSeek Harness coordinates the task, TinyFish retrieves relevant public information, and Houdry Fabric provides the private model-inference infrastructure used to analyze results and produce useful outputs.

## Why TinyFish Is an Integral Part of the Project

AI agents can reason over the information available to them, but many real-world tasks require current information that may not be available in a model's existing knowledge. Technical documentation evolves, product specifications change, new research is published, and industry information appears across many websites.

TinyFish addresses this gap by bringing public-web research into the agent workflow.

- **Live information access:** Research current public information instead of relying exclusively on previously learned model knowledge.
- **Evidence-driven reasoning:** Return retrieved information to Harness for analysis, summarization, and comparison.
- **Multi-source investigation:** Gather information from multiple permitted public sources.
- **End-to-end task completion:** Incorporate web research into technical investigations, documentation, comparisons, and research-backed deliverables.
- **Separation of responsibilities:** Use TinyFish for external information retrieval and Houdry Fabric for private model inference and distributed compute.

TinyFish expands the capabilities of the overall system. It complements the private inference fabric rather than replacing it.

## 🏗️ Architecture

The architecture connects three primary capabilities: **DeepSeek Harness for orchestration, TinyFish for public-web intelligence, and Houdry Fabric for private inference.** The Public Research Gateway governs the information flowing to the external research service.

```mermaid
flowchart TB
    %% User entry point
    USER(["👤 User Request"])

    %% Layer 1: Agent Orchestration
    subgraph ORCHESTRATION["🎯 LAYER 1: AGENT ORCHESTRATION"]
        direction TB
        HARNESS["<b>DeepSeek Harness</b><br/>Houdry Agent Core<br/>━━━━━━━━━━━━━━━━<br/>• Task Planning & Reasoning<br/>• Tool Orchestration<br/>• Workflow Coordination"]
        DECISION{"🤔 Does task need<br/>live web research?"}
        ANALYSIS["<b>Evidence Analysis</b><br/>━━━━━━━━━━━━━━<br/>• Synthesize findings<br/>• Combine sources<br/>• Generate deliverable"]

        HARNESS --> DECISION
        DECISION -->|"Yes<br/>Public info needed"| GATEWAY
        DECISION -->|"No<br/>Use existing knowledge"| ANALYSIS
    end

    %% Layer 2: Web Intelligence
    subgraph WEB_RESEARCH["🌐 LAYER 2: TINYFISH WEB INTELLIGENCE"]
        direction TB
        GATEWAY["<b>🛡️ Public Research Gateway</b><br/>Security Boundary<br/>━━━━━━━━━━━━━━━━━━━━━━<br/>✓ Validate requests<br/>✓ Filter sensitive data<br/>✓ Minimize outbound info<br/>✓ Restrict destinations<br/>✓ Prevent credential leaks"]
        TINYFISH["<b>TinyFish Service</b><br/>━━━━━━━━━━━━━━<br/>Public web search<br/>Content retrieval<br/>Multi-source research"]
        SOURCES[("<b>🌍 Public Web</b><br/>━━━━━━━━━━━<br/>Documentation<br/>Research papers<br/>Product specs<br/>Technical blogs<br/>Public APIs")]
        EVIDENCE["<b>📄 Retrieved Evidence</b><br/>━━━━━━━━━━━━━━━━<br/>⚠️ Untrusted external content<br/>Treated as data, not instructions"]

        GATEWAY -->|"Validated<br/>minimal request"| TINYFISH
        TINYFISH -->|"Search &<br/>retrieve"| SOURCES
        SOURCES -->|"Raw<br/>content"| EVIDENCE
    end

    %% Layer 3: Private Inference
    subgraph INFERENCE["🔐 LAYER 3: PRIVATE HOUDRY FABRIC"]
        direction TB
        FABRIC["<b>Houdry Fabric</b><br/>Private Inference Backend<br/>━━━━━━━━━━━━━━━━━━<br/>• Model routing<br/>• Job scheduling<br/>• Load balancing"]
        WORKERS["<b>⚡ Distributed Workers</b><br/>━━━━━━━━━━━━━━━━<br/>GPU compute nodes"]
        MODELS["<b>🧠 Private Models</b><br/>━━━━━━━━━━━━━━<br/>Your configured<br/>inference models"]

        FABRIC --> WORKERS
        WORKERS --> MODELS
    end

    %% Final output
    OUTPUT(["✅ Research-Backed Answer<br/>or Completed Deliverable"])

    %% Main flow connections
    USER ==>|"Submit task"| HARNESS
    EVIDENCE -->|"Research results<br/>(when available)"| ANALYSIS
    ANALYSIS -.->|"Inference request<br/>(when needed)"| FABRIC
    MODELS -.->|"Analysis results"| ANALYSIS
    ANALYSIS ==>|"Final output"| OUTPUT

    %% Styling
    classDef userClass fill:#1a1f2e,stroke:#4a9eff,stroke-width:3px,color:#ffffff
    classDef orchestrationClass fill:#1e3a5f,stroke:#4a9eff,stroke-width:2px,color:#ffffff
    classDef gatewayClass fill:#5c4a1e,stroke:#ffb344,stroke-width:3px,color:#ffffff
    classDef webClass fill:#1e4d3f,stroke:#44ffaa,stroke-width:2px,color:#ffffff
    classDef evidenceClass fill:#3a3a3a,stroke:#ffaa44,stroke-width:2px,color:#ffffff
    classDef inferenceClass fill:#3a1e5c,stroke:#b388ff,stroke-width:2px,color:#ffffff
    classDef outputClass fill:#1a2e1a,stroke:#44ff88,stroke-width:3px,color:#ffffff

    class USER userClass
    class HARNESS,DECISION,ANALYSIS orchestrationClass
    class GATEWAY gatewayClass
    class TINYFISH,SOURCES webClass
    class EVIDENCE evidenceClass
    class FABRIC,WORKERS,MODELS inferenceClass
    class OUTPUT outputClass
```

### How the Components Work Together

1. **🎯 Harness orchestrates the task.** The user submits a question or task that may require current public information.

2. **🤔 Harness determines whether research is needed.** If the task requires external information, it invokes the dedicated research interface.

3. **🛡️ The Public Research Gateway controls the boundary.** It validates the request, minimizes outbound data, and applies destination and permission restrictions. This is the security checkpoint that prevents sensitive information from leaving your infrastructure.

4. **🌐 TinyFish researches public sources.** It retrieves relevant information from permitted public websites.

5. **📄 Evidence returns to Harness.** Retrieved content is treated as untrusted external data, not as instructions that can override agent policies.

6. **🔐 Houdry Fabric provides private inference when needed.** The configured inference path can analyze the evidence and help generate summaries, comparisons, reports, and other deliverables.

7. **✅ Harness produces the result.** It combines the research and model outputs into the final answer or deliverable.

This architecture allows public information retrieval and private inference to work together while maintaining distinct responsibilities.

## 🛡️ Public Research Gateway: The Boundary Between TinyFish and Private AI

The Public Research Gateway defines what information can leave the agent environment and what operations TinyFish is permitted to perform.

TinyFish should not receive unrestricted Harness context, direct access to private knowledge, or the permissions of the general-purpose agent. Instead, Harness should expose a dedicated public-research interface that sends only the minimum information needed for an approved request.

The gateway is intended to enforce:

- **Request validation:** Accept only supported public-research operations and approved input fields.
- **Sensitive-data filtering:** Reject requests containing prohibited secrets or private organizational content.
- **Data minimization:** Send only the approved query, URL, and necessary parameters.
- **Destination validation:** Restrict access to permitted public destinations and guard against unsafe redirects, private IP addresses, and metadata endpoints.
- **Restricted permissions:** Prevent the research tool from inheriting unrestricted access to internal tools and resources.
- **Untrusted evidence handling:** Treat retrieved content as data to analyze, never as authority to change policies or initiate privileged actions.
- **Fail-closed behavior:** Reject requests when required security checks cannot be completed.

These protections should be enforced in code and verified with tests. Prompt instructions alone are not a sufficient security boundary.

## 🔄 TinyFish and Houdry Fabric: Complementary Capabilities

| Component | Role in the project |
|---|---|
| **TinyFish** | Public-web research and information retrieval |
| **Public Research Gateway** | Request validation, data minimization, and outbound security controls |
| **DeepSeek Harness** | Agent reasoning, planning, tool orchestration, and task coordination |
| **Houdry Fabric** | Private model inference, model routing, and distributed GPU-worker execution |
| **Configured Houdry models** | Analysis, synthesis, summarization, and deliverable generation |

**TinyFish brings in external information. Harness coordinates the workflow. Houdry Fabric powers private inference.** The gateway governs the boundary between external research and private capabilities.

TinyFish does not replace Houdry's inference backend or provide distributed GPU execution. Its value is in supplying timely external information that the agent can incorporate into its work.

## 🔐 Privacy and Security Principles

Because TinyFish is an external service, approved queries, requested URLs, and submitted retrieval parameters may be processed outside the organization's infrastructure. The integration should therefore minimize what is sent and enforce clear limits on outbound research.

The gateway should prevent the forwarding of:

- Internal documents and local file contents
- Private knowledge-base passages
- Full conversation history and hidden agent context
- Confidential source code and proprietary business information
- API keys, tokens, cookies, and enterprise credentials
- Internal service addresses and authenticated enterprise resources

Retrieved pages may contain misleading information or prompt-injection attempts. Harness must keep this content within the evidence-analysis workflow and must not allow it to grant permissions or trigger unauthorized internal actions.

Security tests should verify prohibited-data rejection, destination and redirect validation, credential isolation, prompt-injection handling, and fail-closed behavior.

## 🎯 Project Vision

TinyFish is an important part of making Houdry Agent research-capable: it connects agent workflows to current public information, while Houdry Fabric provides the infrastructure for private inference.

**TinyFish connects the agent to the public web. DeepSeek Harness turns research into a workflow. Houdry Fabric powers private inference. The Public Research Gateway defines the security boundary between them.**
