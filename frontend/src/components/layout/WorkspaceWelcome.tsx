import BrandLogo from '../common/BrandLogo'
import Button from '../common/Button'
import { IconSpinner, IconUpload } from '../common/Icons'
import './WorkspaceWelcome.css'

const steps = [
  { title: 'Inspect', description: 'Review the original document.' },
  { title: 'Refine', description: 'Convert and edit your Markdown.' },
  { title: 'Prepare', description: 'Build and enrich document chunks.' },
]

export default function WorkspaceWelcome({
  uploading,
  onUpload,
}: {
  uploading: boolean
  onUpload: () => void
}) {
  return (
    <section className="workspace-welcome" aria-labelledby="welcome-title">
      <div className="welcome-content">
        <div className="welcome-intro">
          <span className="welcome-eyebrow">From document to retrieval</span>
          <BrandLogo className="welcome-mascot" size={96} />
          <h2 id="welcome-title">Good retrieval starts<br />with good chunks.</h2>
          <p>Inspect, refine, and prepare your documents in one workspace. Open a file from the sidebar or upload one to get started.</p>
          <div className="welcome-action">
            <Button size="md" variant="primary" onClick={onUpload} disabled={uploading}>
              {uploading ? <IconSpinner size={16} className="spin-animation" /> : <IconUpload size={16} />}
              {uploading ? 'Uploading…' : 'Upload document'}
            </Button>
            <span className="welcome-file-hint">PDF &amp; Markdown</span>
          </div>
        </div>
        <ol className="welcome-steps" aria-label="Document preparation workflow">
          {steps.map((step, index) => (
            <li key={step.title}>
              <span className="welcome-step-number" aria-hidden="true">0{index + 1}</span>
              <strong>{step.title}</strong>
              <span>{step.description}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
