import { ConfigError, loadConfig } from './config.js';
import { loadEnv } from './env.js';

loadEnv();

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  switch (command) {
    case 'validate': {
      const cfg = loadConfig();
      console.log(
        `Configuration valid: ${Object.keys(cfg.accounts).length} accounts, ${cfg.rules.length} rules, ${cfg.exceptions.length} exceptions.`,
      );
      return 0;
    }
    default:
      console.error(`Unknown command: ${command ?? '(none)'}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  },
);
