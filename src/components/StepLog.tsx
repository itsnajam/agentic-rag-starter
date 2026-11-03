export type AgentStepView = {
  step: number;
  action: string;
  toolInput?: Record<string, unknown>;
  resultSummary: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

/** The working, not just the verdict. This is what makes an agent reviewable. */
export function StepLog({ steps }: { steps: AgentStepView[] }) {
  return (
    <section className="steps" aria-label="agent step log">
      <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Steps</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Action</th>
            <th>Input</th>
            <th>Result</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.step}>
              <td>{s.step}</td>
              <td>{s.action}</td>
              <td>{s.toolInput ? JSON.stringify(s.toolInput).slice(0, 90) : "-"}</td>
              <td>{s.resultSummary}</td>
              <td>${s.costUsd.toFixed(6)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
