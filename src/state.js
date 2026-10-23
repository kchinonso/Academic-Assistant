const state = new Map();

function getChatState(chatId) {
  if (!state.has(chatId)) {
    state.set(chatId, {
      folderId: null,
      breadcrumb: [],
      lastItems: [],
      lastMode: "browse",
      roots: [],
      pendingItem: null,
      studyItems: [],
    });
  }
  return state.get(chatId);
}

function resetChatState(chatId) {
  state.set(chatId, {
    folderId: null,
    breadcrumb: [],
    lastItems: [],
    lastMode: "browse",
    roots: [],
    pendingItem: null,
    studyItems: [],
  });
}

module.exports = { getChatState, resetChatState };
