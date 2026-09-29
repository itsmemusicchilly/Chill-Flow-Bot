function Icon({ guild }) {
  if (guild.icon) return <img className="guild-icon" src={guild.icon} alt="" width="48" height="48" />;
  return <div className="guild-icon fallback" aria-hidden="true">{guild.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3)}</div>;
}

export default function GuildPicker({ me, onOpen, onRefresh, onLogout }) {
  const ready = me.guilds.filter((g) => g.botPresent);
  const missing = me.guilds.filter((g) => !g.botPresent);
  const need = me.meta.minPermission === 'ManageGuild' ? 'Manage Server' : 'Administrator';
  return (
    <main className="picker">
      <header className="picker-head">
        <h1>Choose a server</h1>
        <div className="row">
          <img className="avatar" src={me.user.avatar} alt="" width="28" height="28" />
          <span>{me.user.name}</span>
          <button className="btn ghost" onClick={onLogout}>Log out</button>
        </div>
      </header>
      <p className="muted">Servers where you have the <b>{need}</b> permission.</p>

      {ready.length > 0 && (
        <section aria-label="Servers with the bot">
          <div className="grid">
            {ready.map((g) => (
              <button key={g.id} className="guild-card" onClick={() => onOpen(g)}>
                <Icon guild={g} />
                <div className="guild-name">{g.name}</div>
                <span className="pill ok">Open editor →</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {missing.length > 0 && (
        <section aria-label="Servers without the bot">
          <h2>Add the bot first</h2>
          <div className="grid">
            {missing.map((g) => (
              <div key={g.id} className="guild-card dim">
                <Icon guild={g} />
                <div className="guild-name">{g.name}</div>
                <a className="btn" href={g.inviteUrl} target="_blank" rel="noreferrer">Add bot ↗</a>
              </div>
            ))}
          </div>
          <p className="muted tiny">After adding the bot, press <button className="link" onClick={onRefresh}>refresh</button>.</p>
        </section>
      )}

      {me.guilds.length === 0 && (
        <div className="empty">
          <p>You do not manage any servers yet. Ask an owner to give you the <b>{need}</b> permission, then log in again.</p>
          <button className="btn" onClick={onRefresh}>Refresh</button>
        </div>
      )}
    </main>
  );
}
