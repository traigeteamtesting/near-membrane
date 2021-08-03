# `near-membrane-embedded`

A near-membrane for use in embedded hosts. Supports `JavaScriptCore` and `V8`.

## Usage


### Install JavaScript Shells

Use `esvu` to install JavaScript shells: `npm install esvu -g`. If JSC does not install correctly, try installing `esvu` with `npm install devsnek/esvu -g`.


### Running Code In JavaScript Shells

Before we introduce test runner pipeline concepts, you can experiment with the JavaScript shells directly. First, try executing a string of code, like this:

```sh
jsc -e 'print("Hello")'

# or

v8 -e 'print("Hello")'
```

In both cases, the result will be:

```sh
Hello
```

Next, create a file and provide it directly to a JavaScript shell:

```sh
echo 'print("Hello");' >> hello.js;

jsc hello.js

# or

v8 hello.js
```

Again, the result will be:

```sh
Hello
```

Finally, run either shell with no arguments and you'll be presented with REPL:

```sh
jsc
>>> print("Hello")
Hello
```

or

```sh
v8
>>> print("Hello")
Hello
```


## How Testing Works In This Module


### Create The Universe

JavaScript shells are bare bones host environments that are used by the implementation itself to test the JavaScript engine directly. In order to effectively use them for testing JavaScript code, an operator (you or your test runner) must assume that everything that's needed run some given JavaScript must be provided; in practice, that means that all "things" that are not defined by the ECMAScript specification must be defined within the script or module code that will be consumed by the shell, to be evaluated by the engine.

```
   ┌─────────────────────────────────────┐
 ┌─┤     Individual JavaScript Files     ├─┐
 │ └─────────────────────────────────────┘ │                                      ┌────────────────────────────────┐
 │ ┌─────────────────────────────────────┐ │                                      │                                │
 │ │                                     │ │      ┌───────────────────────────┐   │                                │
 │ │                                     │ │      │Preprocessor/Concatenation │   │                                │
 │ │      Test Harness Source Code       │─┼─────┐└───────────────────────────┘   │                                │
 │ │                                     │ │     │              Λ                 │                                │
 │ │                                     │ │     │             ╱ ╲                │                                │
 │ └─────────────────────────────────────┘ │     │            ╱   ╲               │                                │
 │                                         │     │           ╱     ╲              │                                │
 │ ┌─────────────────────────────────────┐ │     │          ╱       ╲             │                                │
 │ │                                     │ │     │         ╱         ╲            │                                │
 │ │                                     │ │     │        ╱           ╲           │                                │
 │ │      Test Contents Source Code      │─┼─────┼──────▶▕             ▏──────────▶     Standalone Test Source     │
 │ │                                     │ │     │        ╲           ╱           │           Code File            │
 │ │                                     │ │     │         ╲         ╱            │           (test.js)            │
 │ └─────────────────────────────────────┘ │     │          ╲       ╱             │                                │
 │                                         │     │           ╲     ╱              │                                │
 │ ┌─────────────────────────────────────┐ │     │            ╲   ╱               │                                │
 │ │                                     │ │     │             ╲ ╱                │                                │
 │ │       Test Harness Invocation       │ │     │              V                 │                                │
 │ │      or Resolution Source Code      │─┼─────┘                                │                                │
 │ │                                     │ │                                      │                                │
 │ │                                     │ │                                      │                                │
 │ └─────────────────────────────────────┘ │                                      │                                │
 │                                         │                                      │                                │
 └─────────────────────────────────────────┘                                      └────────────────────────────────┘
```


Then, `test.js` can be executed by providing it directly to the JavaScript shell:


```sh
jsc test.js

# or

v8 test.js
```

### Test Within The Universe

Since `near-membrane-node` contains a valuable source of test material, and because we don't want to maintain two sets of nearly identical test sources, this module makes use of those tests already written for `near-membrane-node`. In order to accomplish this, a Rollup based pipeline must:

1. "Create the Universe" (as described in [Create The Universe](#create-the-universe))
2. Resolve this module's dependency graph and combine that with the newly created universe
2. Modify some aspects of `near-membrane-node`'s test material to make it appropriate for the JavaScript host shells, and then combine that with accumulating universe
3. Save the resulting universe to a file in the system's temporary file location
4. Invoke the host as a child process, providing the path to the temporary file as an argument
5. Capture the stdout of the child process, and continue.
6. Once all test materials are exhausted, report the captured stdout.


### Build Your Own Universe

To create your own scenarios outside of the shared test material testing pipeline described in [Test Within The Universe](#test-within-the-universe), you must include the contents of `lib/index.js` in either the result of a test source concatenation operation, or through a Rollup pipeline.


Here's a very basic demonstration:


```sh
echo "$(cat lib/index.js);\nprint(typeof createVirtualEnvironment)" >> test.js;

jsc test.js;

# or

v8 test.js
```
(Note that `\n` is required because the last line of `lib/index.js` is `//# sourceMappingURL=index.js.map`)

In both cases, the result will be:


```sh
function
```
