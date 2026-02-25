const { select } = require('@inquirer/prompts');
(async () => {
  const answer = await select({
    message: 'Do you want to proceed?',
    choices: [
      { name: '1. Yes', value: 'yes' },
      { name: '2. Yes, and always allow access', value: 'always' },
      { name: '3. No', value: 'no' }
    ]
  });
  console.log('Answer:', answer);
})();
