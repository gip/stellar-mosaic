import ArchDiagram from "../components/ArchDiagram";

export default function OverviewPage() {
  return (
    <div className="reading">
      <h2>Overview</h2>
      <p className="muted">
        Stellar Mosaic is a privacy-preserving OTC desk on Stellar. It is
        owner-anonymous and amount-transparent: <strong>who</strong> is behind a
        trade stays confidential, while the assets and amounts settling on-chain
        are public.
      </p>
      <p className="muted">
        You stay in control of your assets at all times; assuming the contracts are bug-free and
        you keep your notes, no loss of funds can happen by design.
      </p>
      <p className="muted">Several Trust models are supported</p>
      <ArchDiagram />
    </div>
  );
}
