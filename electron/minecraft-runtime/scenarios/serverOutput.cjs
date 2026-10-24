'use strict';

function createOutputBuffer({ limit = 1_000_000, retained = 200_000 } = {}) {
  let text = '';
  let start = 0;
  return {
    append(chunk) {
      text += chunk;
      if (text.length > limit) {
        const removed = text.length - retained;
        text = text.slice(removed);
        start += removed;
      }
    },
    offset: () => start + text.length,
    textFrom: (absoluteOffset = 0) => text.slice(Math.max(0, absoluteOffset - start)),
  };
}

module.exports = { createOutputBuffer };
