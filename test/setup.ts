// Fail a test that leaves a floating promise or an unhandled rejection, rather than
// letting it surface as a confusing failure in an unrelated test.
process.on('unhandledRejection', (reason) => {
  throw reason;
});

jest.setTimeout(30_000);
