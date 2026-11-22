module.exports = {
  checks: {
    async setThing() {
      return null;
    },
  },
  skip: ['invoke.initializeThing', /^invoke\.setOther.*Name$/],
  enumerations: [async () => []],
};
