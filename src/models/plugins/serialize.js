/** Exposes Mongoose's built-in `id` virtual and drops `_id`/`__v` from JSON output. */
function serialize(schema) {
  schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret) => {
      delete ret._id;
      return ret;
    },
  });
}

module.exports = serialize;
