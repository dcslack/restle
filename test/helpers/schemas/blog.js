module.exports = {
  attributes: {
    'title': { type: 'string', required },
    'content': { type: 'string', required },
    'last-edited': { type: 'date' },
    'created-on': { type: 'date', default: Date.now },
  },
  relationships: {
    'author': { type: 'user', multiplicity: 'one' },
    'comments': { type: 'comment', multiplicity: 'many' },
  },
};
