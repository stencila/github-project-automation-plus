const core = require('@actions/core');
const github = require('@actions/github');

const getData = () => {
	const {eventName, payload} = github.context;
	if (eventName !== 'pull_request' && eventName !== 'issues') {
		throw new Error(`Only pull requests or issues allowed, received:\n${eventName}`);
	}

	const githubData = eventName === 'issues' ?
		payload.issue :
		payload.pull_request;

	return {
		eventName,
		action: payload.action,
		nodeId: githubData.node_id,
		url: githubData.html_url
	};
};

(async () => {
	try {
		const token = core.getInput('repo-token');
		const project = core.getInput('project');
		const column = core.getInput('column');
		const onNewOnly = core.getInput('on-new');

		const {eventName, action, nodeId, url} = getData();

		// Get the column ID from searching for the project and card Id if it exists
		const fetchColumnQuery = `query {
			resource( url: "${url}" ) {
				... on ${eventName === 'issues' ? 'Issue' : 'PullRequest'} {
					projectCards {
						nodes {
							id
							project {
								name
							}
						}
					}
					repository {
						projects( search: "${project}", first: 10, states: [OPEN] ) {
							nodes {
								id
								name
								columns( first: 100 ) {
									nodes {
										id
										name
									}
								}
							}
						}
						owner {
							... on ProjectOwner {
								projects( search: "${project}", first: 10, states: [OPEN] ) {
									nodes {
										id
										name
										columns( first: 100 ) {
											nodes {
												id
												name
											}
										}
									}
								}
							}
						}
					}
				}
			}
		}`;

		const octokit = new github.GitHub(token);
		const {resource} = await octokit.graphql(fetchColumnQuery);

		// All the projects found
		const repoProjects = resource.repository.projects.nodes || [];
		const orgProjects = (resource.repository.owner &&
			resource.repository.owner.projects &&
			resource.repository.owner.projects.nodes) ||
			[];

		// Get the column data of projects and columns that match input
		const columns = [...repoProjects, ...orgProjects]
			.filter(foundProject => foundProject.name === project)
			.flatMap(foundProject => foundProject.columns.nodes ?
				foundProject.columns.nodes.filter(projectColumn => projectColumn.name === column) :
				[]
			);

		if (columns.length === 0) {
			throw new Error(`Could not find the column "${column}" in project "${project}"`);
		}

		// Check if the issue alread has a project associated to it
		const cards = resource.projectCards.nodes.length === 0 ?
			resource.projectCards.nodes.filter(card => card.project.name === project) :
			[];
		const cardId = cards.length > 0 ? cards[0].id : null;

		// If a card already exists, and `on-new` is `true` terminate early
		// as the card column should not be changed
		if (cardId && onNewOnly === true) {
			console.log(`🆗 Card already assigned to ${project}. No changes needed.`);
			return
		}

		if (cardId) {
			await Promise.all(
				columns.map(column => octokit.graphql(`mutation {
					moveProjectCard( input: { cardId: "${cardId}", columnId: "${column.id}"
				}) { clientMutationId } }`))
			);
		// If the card does not exist, add it to the column
		} else {
			await Promise.all(
				columns.map(column => octokit.graphql(`mutation {
					addProjectCard( input: { contentId: "${nodeId}", projectColumnId: "${column.id}"
				}) { clientMutationId } }`))
			);
		}

		console.log(`✅ ${action === 'opened' ? 'Added' : 'Moved'} card to ${column} in ${project}`);
	} catch (error) {
		core.setFailed(error.message);
	}
})();
