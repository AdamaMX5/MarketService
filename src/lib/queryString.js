// Defense in depth for query-driven Mongoose filters: even with the `simple` query
// parser (app.js) ruling out nested objects, a repeated key (`?x=a&x=b`) still
// parses to an array — reject anything that isn't a single plain string before it
// ever reaches a filter object.
function stringParam(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

module.exports = { stringParam };
