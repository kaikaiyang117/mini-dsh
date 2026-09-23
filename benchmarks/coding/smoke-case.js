export const SMOKE_CASE = Object.freeze({
    name: 'bugfix-single-file',
    prompt: [
        'Fix the clamp bug in this small local JavaScript workspace.',
        'Search for and read calculator.js and calculator.test.js.',
        'First run the failing tests with bash(command="env -u NODE_TEST_CONTEXT node --test calculator.test.js").',
        'Edit only calculator.js, then run the same test command again and confirm it passes.',
        'Work only inside the benchmark workspace. Do not access network, HOME, or external paths.',
    ].join(' '),
    expected: { completion: 'stop-reason', stopReason: 'completed' },
})
