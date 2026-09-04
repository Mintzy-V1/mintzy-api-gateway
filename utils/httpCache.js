const store = new Map();

const run = async (key, ttlMs, loader) => {
  const entry = store.get(key);
  if (entry) {
    if (Date.now() - entry.at < ttlMs) return entry.value;
    store.delete(key);
  }
  const value = await loader();
  store.set(key, { at: Date.now(), value });
  return value;
};

const del = (key) => store.delete(key);

/** Clear every cached entry touching a session id. */
const invalidateSession = (sessionId) => {
  if (!sessionId) return;
  for (const key of store.keys()) {
    if (key.includes(sessionId)) store.delete(key);
  }
};

/** Clear every cached entry touching a user id (e.g. the sessions list). */
const invalidateUser = (userId) => {
  if (!userId) return;
  for (const key of store.keys()) {
    if (key.includes(userId)) store.delete(key);
  }
};

const flush = () => store.clear();

export { run, del, invalidateSession, invalidateUser, flush };
export default { run, del, invalidateSession, invalidateUser, flush };