const MESSAGES = {
  failed: 'Login did not work. Please try again.',
  denied: 'You cancelled the login.',
};

export default function LoginScreen() {
  const error = MESSAGES[new URLSearchParams(window.location.search).get('login')];
  return (
    <main className="login">
      <div className="login-card">
        <div className="login-logo" aria-hidden="true">🤖</div>
        <h1>Build your Discord bot with flowcharts</h1>
        <p className="muted">
          Pick a trigger — a slash command, someone joining, a reaction — then connect actions: send messages with buttons,
          give roles, create channels, remember variables. No code.
        </p>
        <ul className="login-points">
          <li>🔗 Every button gets its own path</li>
          <li>🛡️ Only server admins can edit their own server</li>
          <li>⚡ Changes go live the moment you save</li>
        </ul>
        {error && <div className="banner bad" role="alert">{error}</div>}
        <a className="btn primary big" href="/auth/login">Log in with Discord</a>
        <p className="tiny muted">We only read your username and which servers you manage.</p>
      </div>
    </main>
  );
}
