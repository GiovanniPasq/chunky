import { Component, type ReactNode } from 'react'
import './ErrorBoundary.css'

interface State { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <span className="error-boundary__icon">⚠️</span>
          <h2 className="error-boundary__title">Something went wrong</h2>
          <pre className="error-boundary__message">{this.state.error.message}</pre>
          <button
            className="error-boundary__btn"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
