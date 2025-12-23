import { useEffect, useState } from "react";

export default function App() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    fetch("/api/v1/health")
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      })
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>DDJ Player</h1>
      {err && <pre style={{ color: "red" }}>{err}</pre>}
      {data ? <pre>{JSON.stringify(data, null, 2)}</pre> : <p>Chargement…</p>}
    </div>
  );
}

