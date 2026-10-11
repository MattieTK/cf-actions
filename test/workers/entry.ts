export { AppRegistry } from "../../src/durable/app-registry";
export { JobLedger } from "../../src/durable/job-ledger";

export default {
	fetch: () => new Response("storage test worker"),
};
