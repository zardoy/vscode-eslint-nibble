//@ts-check
const { defineConfig } = require('@zardoy/vscode-utils/build/defineConfig.cjs')
const { patchPackageJson } = require('@zardoy/vscode-utils/build/patchPackageJson.cjs')

patchPackageJson({})

module.exports = defineConfig({
    development: {
        disableExtensions: false,
    },
})
