import { Message } from 'discord.js';
import Database from 'better-sqlite3';
import * as diff from 'recursive-diff';
import * as he from 'he';
import * as _ from 'lodash';
import * as fs from 'fs';
import * as path from 'path';
import GeneralHelpers from '../services/general-helpers';
import RSINetwork from '../services/rsi-network';

/**
 * Bot commands for analyzing the RSI roadmap and progress tracker
 */
export abstract class Roadmap {
    //#region Public properties
    /** The bot base command */
    public static readonly command = '!roadmap';
    
    /** The functionality of the command */
    public static readonly description = 'Keeps track of roadmap changes from week to week. Pull the latest version of the roadmap for today or to compare the latest pull to the previous.';
    
    /** 
     * The bot command pattern
     * --publish can be added to compare and teams to generate extras for website publishing */
    public static readonly usage = 'Usage: `!roadmap  \n\tpull <- Pulls progress tracker delta  \n\tcompare [-s YYYYMMDD, -e YYYYMMDD] '+
        '<- Generates a delta report for the given dates; leave none for most recent  \n\tteams <- Generates a report of currently assigned deliverables`';
    //#endregion

    //#region Private properies
    /** The report category enum */
    private static readonly ReportCategoryEnum = Object.freeze({
        Delta: "Delta",
        Teams: "Teams"
    });

    /** Set to true to allow the command to export to discord */
    private static readonly AllowExportSnapshotsToDiscord = false;
    //#endregion

    /**
     * Executes the bot commands
     * @param msg The msg that triggered the command
     * @param args Available arguments included with the command
     * @param db The database connection
     */
    public static execute(msg: Message, args: Array<string>, db: Database) {
        // const officer = msg.guild.roles.cache.find(role => role.name === 'Officer');
        // if(officer && !msg.member.roles.highest.comparePositionTo(officer)) {
        //     // inufficient privileges
        //     return;
        // }

        switch(args[0]) {
            case 'pull':
                this.delta(msg, db);
                break;
            case 'compare':
                this.generateProgressTrackerDeltaReport(args, msg, db);
                break;
            case 'teams':
                this.lookup(["-t", ...args], msg, db);
                break;
            case 'export':
                this.exportJson(args, msg, db, true);
                break;
            default:
                msg.channel.send(this.usage).catch(console.error);
                break;
        }
    }

    //#region Generate Delta
    /**
     * Looks up data from RSI and stores the delta
     * @param msg The command message
     * @param db The database connection
     */
    private static async delta(msg: Message, db: Database) {
        msg.channel.send('Retrieving roadmap state...').catch(console.error);
        let start = Date.now();
        let deliverables = [];
        let offset = 0;
        //const sortBy = 'd' in argv ? this.SortByEnum.CHRONOLOGICAL : this.SortByEnum.ALPHABETICAL;
        let completedQuery = true;
        const initialResponse = await RSINetwork.getResponse(RSINetwork.deliverablesQuery(offset, 1), RSINetwork.QueryTypeEnum.Deliverables).catch((e) => {
            completedQuery = false;
        }); // just needed for the total count; could speed up by only grabbing this info and not the rest of the metadata
        let deliverablePromises = [];

        do {
            deliverablePromises.push(RSINetwork.getResponse(RSINetwork.deliverablesQuery(offset, 20), RSINetwork.QueryTypeEnum.Deliverables, offset).catch(() => completedQuery = false));
            offset += 20;
        } while(offset < initialResponse.totalCount)

        Promise.all(deliverablePromises).then((responses)=>{
            if(!completedQuery) {
                return msg.channel.send(`Roadmap retrieval timed out; please try again later.`).catch(console.error);
            }

            responses.forEach((response)=>{
                const metaData = response.metaData;
                deliverables = deliverables.concat(metaData);
            });

            // download and attach development team time assignments to each deliverable
            const teamPromises = [];
            deliverables.forEach((d) => {
                teamPromises.push(RSINetwork.getResponse(RSINetwork.teamsQuery(offset, d.slug), RSINetwork.QueryTypeEnum.Teams, 20 * teamPromises.length).catch(() => completedQuery = false));
            });

            Promise.all(teamPromises).then(async (responses) => {
                if(!completedQuery) {
                    return msg.channel.send(`Roadmap team retrieval timed out; please try again later.`).catch(console.error);
                }

                const disciplinePromises = []; // get dev lists for each team/deliverable combination
                responses.forEach((response, index)=>{
                    // order is preserved, team index matches deliverable index
                    const metaData = response.metaData;
                    deliverables[index].teams = metaData;
                    deliverables[index].teams.forEach(t => {
                        disciplinePromises.push(RSINetwork.getResponse(RSINetwork.disciplinesQuery(t.slug, deliverables[index].slug), RSINetwork.QueryTypeEnum.Disciplines, 20 * disciplinePromises.length).catch(() => completedQuery = false));
                    });
                });

                Promise.all(disciplinePromises).then(async (disciplineResults) => {
                    if(!completedQuery) {
                        return msg.channel.send(`Roadmap discipline retrieval timed out; please try again later.`).catch(console.error);
                    }
                    disciplineResults.forEach(disciplines => {
                        disciplines.forEach(discipline => {
                            // TODO - refactor this; not sure how to just select the matching time allocation at the bottom of the search, but this can't be efficient
                            const dMatch = deliverables.find(d => d.teams && d.teams.find(t => t.timeAllocations && t.timeAllocations.find(ta => discipline.timeAllocations && discipline.timeAllocations.some(dta => dta.uuid === ta.uuid))));
                            if(dMatch) {
                                const team = dMatch.teams.find(t => t.timeAllocations.some(ta => discipline.timeAllocations.some(dta => dta.uuid === ta.uuid)));
                                const timeAllocations = team.timeAllocations.filter(ta => discipline.timeAllocations.some(dta => dta.uuid === ta.uuid));

                                // A given discipline is assigned to exactly one, unique time allocation
                                timeAllocations.forEach(ta => {
                                    ta.discipline = discipline;
                                });
                            }
                        });
                    });

                    let delta = Date.now() - start;
                    console.log(`Deliverables: ${deliverables.length} in ${delta} milliseconds`);
    
                    const compareTime = Date.now();
    
                    // populate db with initial values
                    let deliverableDeltas = db.prepare("SELECT COUNT(*) as count FROM deliverable_diff").get();
                    if(!deliverableDeltas.count) {
                        
                        const initializationDataDir = path.join(__dirname, '..', 'initialization_data');
                        fs.readdirSync(initializationDataDir).forEach((file) => {
                            const data = JSON.parse(fs.readFileSync(path.join(initializationDataDir, file), 'utf-8'));
                            this.insertChanges(db, GeneralHelpers.convertDateToTime(file), this.adjustData(data));
                        });
                    }
    
                    const newDeliverables = this.adjustData(deliverables);
                    const changes = this.insertChanges(db, compareTime, newDeliverables);
                    console.log(`Database updated with delta in ${Date.now() - compareTime} ms`);
    
                    if(changes.updated || changes.removed || changes.readded || changes.added) {
                        const readdedText = changes.readded ? ` with \`${changes.readded} returning\`` : "";
                        msg.channel.send(`Roadmap retrieval returned ${deliverables.length} deliverables in ${delta} ms with`+
                            `  \n\`${changes.updated} modifications\`, \`${changes.removed} removals\`, and \`${changes.added} additions\`${readdedText}.  \n`+
                            ` Type \`!roadmap compare\` to compare to the last update!`).catch(console.error);
                    } else {
                        msg.channel.send('No changes have been detected since the last pull.').catch(console.error);
                    }
                }).catch(console.error);
            }).catch(console.error);
        }).catch(console.error);
    }

    /**
     * Adjust the deliverable objects for db insertion
     * @param deliverables The deliverables list to adjust
     * @returns The adjusted data
     */
     private static adjustData(deliverables: any[]): any[] {
        deliverables.forEach((d)=>{
            d.startDate = Date.parse(d.startDate);
            d.endDate = Date.parse(d.endDate);
            d.updateDate = Date.parse(d.updateDate);
            d.title = _.unescape(d.title);
            d.description = _.unescape(d.description);
            if(d.card) {
                d.card.tid = d.card.id;
                if(d.card.release) {
                    d.card.release_id = d.card.release.id;
                    d.card.release_title = d.card.release.title;
                } else {
                    d.card.release_id = d.card.release_id;
                    d.card.release_title = d.card.release_title;
                }
                d.card.updateDate = Date.parse(d.card.updateDate);
                delete(d.card.id);
            }
            if(d.teams) {
                d.teams.forEach((team) => {
                    team.startDate = Number(team.startDate) ? team.startDate : Date.parse(team.startDate);
                    team.endDate = Number(team.endDate) ? team.endDate : Date.parse(team.endDate);
                    if(team.timeAllocations) {
                        team.timeAllocations.forEach((ta) => {
                            ta.startDate = Date.parse(ta.startDate);
                            ta.endDate = Date.parse(ta.endDate);
                            if(ta.discipline) {
                                ta.numberOfMembers = ta.discipline.numberOfMembers;
                                ta.title = ta.discipline.title;
                                ta.disciplineUuid = ta.discipline.uuid;
                                delete(ta.discipline);
                            }
                        });
                    }
                });
            }
        });
        return deliverables;
    }

    /** 
     * Generate delta entries for each deliverable and their children (teams, time allocations, release card)
     * @param db The database connection 
     * @param now The time to use for addedTime entries
     * @param deliverables The deliverable entries to add
     * @returns The changes that were detected (addition, removal, modification)
     */
    private static insertChanges(db: Database, now: number, deliverables: any[]): any {
        // TODO - Refactor code, use joins where possible

        const deliverableInsert = db.prepare("INSERT INTO deliverable_diff (uuid, slug, title, description, addedDate, numberOfDisciplines, numberOfTeams, totalCount, card_id, project_ids, startDate, endDate, updateDate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
        const cardsInsert = db.prepare("INSERT INTO card_diff (tid, title, description, category, release_id, release_title, updateDate, addedDate, thumbnail) VALUES (?,?,?,?,?,?,?,?,?)");
        const teamsInsert = db.prepare("INSERT INTO team_diff (abbreviation, title, description, startDate, endDate, addedDate, numberOfDeliverables, slug) VALUES (?,?,?,?,?,?,?,?)");
        const deliverableTeamsInsert = db.prepare("INSERT or IGNORE INTO deliverable_teams (deliverable_id, team_id) VALUES (?,?)");
        const timeAllocationInsert = db.prepare("INSERT INTO timeAllocation_diff (startDate, endDate, addedDate, uuid, partialTime, team_id, deliverable_id, discipline_id) VALUES (?,?,?,?,?,?,?,?)");
        const disciplinesInsert = db.prepare("INSERT INTO discipline_diff (numberOfMembers, title, uuid, addedDate) VALUES (?,?,?,?)");

        // filter out deliverables that had their uuids changed, except for unnanounced content (we don't know if one content is the same as another if their uuid changes)
        let dbDeliverables = db.prepare("SELECT *, MAX(addedDate) FROM deliverable_diff GROUP BY uuid ORDER BY addedDate DESC").all();
        const announcedDeliverables = _._(dbDeliverables.filter(d => d.title && !d.title.includes("Unannounced"))).groupBy('title').map(d => d[0]).value();
        const unAnnouncedDeliverables = dbDeliverables.filter(d => d.title && d.title.includes("Unannounced"));
        dbDeliverables = [...announcedDeliverables, ...unAnnouncedDeliverables];

        let dbTeams = db.prepare("SELECT *, MAX(addedDate) FROM team_diff GROUP BY slug").all();
        const mostRecentDeliverableIds = dbDeliverables.map((dd) => dd.id).toString();
        const dbDeliverableTeams = db.prepare(`SELECT * FROM team_diff WHERE id IN (SELECT team_id FROM deliverable_teams WHERE deliverable_id IN (${mostRecentDeliverableIds}))`).all();
        const dbCards = db.prepare("SELECT *, MAX(addedDate) FROM card_diff GROUP BY tid").all();
        let dbTimeAllocations = db.prepare(`SELECT *, MAX(addedDate) FROM timeAllocation_diff WHERE deliverable_id IN (${mostRecentDeliverableIds}) GROUP BY uuid`).all();
        const mostRecentDisciplineIds = dbTimeAllocations.filter(dd => dd.discipline_id).map((dd) => dd.discipline_id).toString();
        let dbDisciplines = db.prepare(`SELECT *, MAX(addedDate) FROM discipline_diff WHERE id IN (${mostRecentDisciplineIds}) GROUP BY uuid`).all();

        // TODO - investigate cleaning up removed deliverables code below, check buildDeliverables()
        const dbRemovedDeliverables = dbDeliverables.filter(d => d.startDate === null && d.endDate === null);
        const removedDeliverables = dbDeliverables.filter(f => !deliverables.some(l => l.uuid === f.uuid || (l.title && l.title === f.title && !l.title.includes("Unannounced"))) &&
            !dbRemovedDeliverables.some(l => l.uuid === f.uuid || (l.title && l.title === f.title && !l.title.includes("Unannounced"))));

        const insertTeamsAndTimeAllocations = (teams: any[], justIds: boolean = true): any => {
            const rTeams = [];
            const rTimes = [];
            const rAddedTeams = [];
            if(teams) {
                const disciplineProperties = ['numberOfMembers', 'title', 'disciplineUuid'];
                teams.forEach((dt) => {
                    const match = dbTeams.sort((a,b) => b.addedDate - a.addedDate).find(t => t.slug === dt.slug);
                    const tDiff = diff.getDiff(match, dt).filter((df) => df.op === 'update');
                    const tChanges = tDiff.map(x => ({change: x.path && x.path[0], val: x.val})).filter(x => x.change !== 'timeAllocations');
                    let teamId = null;
                    if(tChanges.length || !match) { // new or changed
                        const teamRow = teamsInsert.run([dt.abbreviation, dt.title, dt.description, Number(dt.startDate) ? dt.startDate : Date.parse(dt.startDate), Number(dt.endDate) ? dt.endDate : Date.parse(dt.endDate), now, dt.numberOfDeliverables, dt.slug]);
                        teamId = teamRow.lastInsertRowid;
                        if(match) {
                            rAddedTeams.push({matchId: match.id, newId: teamId});
                        }
                        dbTeams.push({id: teamId, addedDate: now, ...dt});
                        if(justIds) {
                            rTeams.push(teamId);
                        } else {
                            rTeams.push({id: teamId, ...dt});
                        }
                    } else {
                        teamId = match.id;
                        rTeams.push(teamId);
                    }

                    // analyze changes to time allocations
                    if(dt.timeAllocations) {
                        dt.timeAllocations.forEach((ta) => {
                            let disciplineId = null;
                            const taMatch = dbTimeAllocations.sort((a,b) => b.addedDate - a.addedDate).find(t => t.uuid === ta.uuid);
                            const taDiff = diff.getDiff(taMatch, ta);
                            const taChanges = taDiff.map(x => ({change: x.path && x.path[0], val: x.val}));

                            const diMatch = dbDisciplines.find(di => di.disciplineUuid === ta.disciplineUuid);
                            if(!diMatch || taChanges.some(tac => disciplineProperties.includes(tac.change && tac.change.toString()))) {
                                const disciplineRow = disciplinesInsert.run([ta.numberOfMembers, ta.title, ta.disciplineUuid, now]);
                                disciplineId = disciplineRow.lastInsertRowid;
                                dbDisciplines.push({id: disciplineId, ...ta}); // filter duplicates
                            } else {
                                disciplineId = diMatch.id;
                            }

                            if(!taMatch || taDiff.length) {
                                dbTimeAllocations.push({team_id: teamId, discipline_id: disciplineId, addedDate: now, ...ta});
                                rTimes.push({team_id: teamId, discipline_id: disciplineId, ...ta});
                            } else {
                                rTimes.push({team_id: teamId, discipline_id: disciplineId, ...taMatch});
                            }
                        });
                    }
                });
            }
            return {teams: rTeams, timeAllocations: rTimes, addedTeams: rAddedTeams};
        }

        const insertDeliverables = db.transaction((dList: [any]) => {
            let changes = {added: 0, removed: 0, updated: 0, readded: 0}; // TODO - keep track of other changes (teams, disciplines, cards, times). Possible that these are sometimes changed without affecting the deliverable
            // check for team differences
            const dTeams = _.uniqBy(dList.filter((d) => d.teams).flatMap((d) => d.teams).map((t)=>_.omit(t, 'timeAllocations', 'uuid')), 'slug');
            if(dbTeams.length) {
                const dbRemovedTeams = dbTeams.filter(t => t.startDate === null && t.endDate === null);
                const removedTeams = dbTeams.filter(f => !dTeams.some(l => l.slug === f.slug) && !dbRemovedTeams.some(l => l.slug === f.slug))
                removedTeams.forEach((rt) => {
                    teamsInsert.run([rt.abbreviation, rt.title, rt.description, null, null, now, rt.numberOfDeliverables, rt.slug]);
                });
            } else { // initialize team_diff
                const inserts = insertTeamsAndTimeAllocations(dTeams, false); // changes to teams or time allocations
                dbTeams = inserts.teams;
                dbTimeAllocations = inserts.timeAllocations;
            }

            if(dbTimeAllocations.length) {
                const dTimes = dList.filter((d) => d.teams).flatMap((d) => d.teams).flatMap((t) => t.timeAllocations);
                const dbRemovedTimeAllocations = dbTimeAllocations.filter(ta => ta.startDate === null && ta.endDate === null && ta.partialTime === null);
                const removedTimes = dbTimeAllocations.filter(f => !dTimes.some(l => l.uuid === f.uuid) && !dbRemovedTimeAllocations.some(l => l.uuid === f.uuid));
                removedTimes.forEach((rt) => {
                    timeAllocationInsert.run([null, null, now, rt.uuid, null, rt.team_id, rt.deliverable_id, rt.discipline_id]);
                });

                // disciplines are directly tied to time allocations by their uuid, one to many relationship
                const dbRemovedDisciplines = dbDisciplines.filter(di => di.numberOfMembers === null);
                const removedDisciplines = dbDisciplines.filter(f => !dTimes.some(l => l.disciplineUuid === f.uuid) && !dbRemovedDisciplines.some(l => l.uuid === f.uuid));
                removedDisciplines.forEach((rd) => {
                    disciplinesInsert.run([null, rd.title, rd.uuid, now]);
                });
            }

            if(dbCards.length) {
                const dCards = dList.filter((d) => d.card).flatMap((d) => d.card);
                const dbRemovedCards = dbCards.filter(f => f.updateDate === null && f.release_id === null && f.release_title === null);
                const removedCards = dbCards.filter(f => !dCards.some(l => l.tid === f.tid) && !dbRemovedCards.some(l => l.tid === f.tid));
                removedCards.forEach((rc) => {
                    cardsInsert.run([rc.tid, rc.title, rc.description, rc.category, null, null, null, now, rc.thumbnail]);
                });
            }

            removedDeliverables.forEach((r) => {
                deliverableInsert.run([r.uuid, r.slug, r.title, r.description, now, null, null, r.totalCount, null, null, null, null, null]);
                changes.removed++;
            });

            let addedCards = []; // some deliverables share the same release view card (ie. 'Bombs' and 'MOAB')
            let addedTeams = []; // team parameters can change without related deliverables updating (ie. end date shifts outward)
            let addedDeliverables = []; // deliverables can update without affecting children (name/description/updateDate)
            dList.forEach((d) => {
                const dMatch = dbDeliverables.find((dd) => dd.uuid === d.uuid || (d.title && dd.title === d.title && !d.title.includes("Unannounced")));
                const gd = diff.getDiff(dMatch, d).filter((df) => df.op === 'update');

                let team_ids = [];
                let timeAllocations = [];
                // check for changes to team and time allocations separate from deliverable. possible for sprints to change without affecting aggregate start and end dates
                if(d.teams) {
                    const inserts = insertTeamsAndTimeAllocations(d.teams); // changes to teams or time allocations
                    team_ids = inserts.teams;
                    addedTeams = [...addedTeams, ...inserts.addedTeams];
                    timeAllocations = inserts.timeAllocations; // updated time allocations
                }

                if(gd.length || !dMatch || !dbDeliverableTeams.length || team_ids.length || timeAllocations.length) {
                    let card_id = null;
                    if(d.card) {
                        const cMatch = dbCards.find((dc) => dc.tid === d.card.tid);
                        const cgd = diff.getDiff(cMatch, d.card).filter((df) => df.op === 'update');
                        if(!cMatch || cgd.length) {
                            const sharedCard = addedCards.find(c => c.tid === d.card.tid);
                            if(sharedCard) {
                                card_id = sharedCard.id;
                            } else {
                                const row = cardsInsert.run([d.card.tid, d.card.title, d.card.description, d.card.category, d.card.release_id, d.card.release_title, d.card.updateDate, now, d.card.thumbnail]);
                                card_id = row.lastInsertRowid;
                                addedCards.push({tid: d.card.tid, id: card_id});
                            }
                        } else {
                            card_id = cMatch.id;
                        }
                    }

                    const projectIds = d.projects.map(p => { return p.title === 'Star Citizen' ? 'SC' : (p.title === 'Squadron 42' ? 'SQ42' : null); }).toString();

                    let did = null;
                    if(!dMatch || (dMatch && gd.length)) {
                        const row = deliverableInsert.run([d.uuid, d.slug, d.title, d.description, now, d.numberOfDisciplines, d.numberOfTeams, d.totalCount, card_id, projectIds, d.startDate, d.endDate, d.updateDate]);
                        did = row.lastInsertRowid;
                        if(dMatch) {
                            addedDeliverables.push({matchId: dMatch.id, newId: did});
                        }
                        if(dMatch && dMatch.startDate && dMatch.endDate) {
                            changes.updated++;
                        } else {
                            changes.added++;
                            if (dMatch) {
                                changes.readded++;
                            }
                        }
                    } else {
                        did = dMatch.id;
                    }

                    team_ids.forEach((tid) => {
                        deliverableTeamsInsert.run([did, tid]);
                    });

                    timeAllocations.forEach((ta) => {
                        timeAllocationInsert.run([ta.startDate, ta.endDate, now, ta.uuid, ta.partialTime?1:0, ta.team_id, did, ta.discipline_id]);
                    });
                }
            });

            // Update deliverable team relationships when deliverable and team update separately of each other
            const addedTeamIds = addedTeams.map(z => z.matchId).join(',');
            const addedDeliverableIds = addedDeliverables.map(z => z.matchId).join(',');
            const oldDeliverableTeams = db.prepare(`SELECT * FROM deliverable_teams WHERE team_id IN (${addedTeamIds}) OR deliverable_id IN (${addedDeliverableIds})`).all();
            oldDeliverableTeams.forEach(dt => {
                const matchedTeam = addedTeams.find(at => at.matchId === dt.team_id);
                const matchedDeliverable = addedDeliverables.find(d => d.matchId === dt.deliverable_id);
                if(matchedTeam || matchedDeliverable) {
                    deliverableTeamsInsert.run([matchedDeliverable ? matchedDeliverable.newId : dt.deliverable_id, matchedTeam ? matchedTeam.newId : dt.team_id]);
                }
            });

            // Update time allocations when team or deliverable update, but time allocations don't
            const oldTimeAllocations = db.prepare(`SELECT * FROM timeAllocation_diff WHERE team_id IN (${addedTeamIds}) OR deliverable_id IN (${addedDeliverableIds}) AND partialTime IS NOT NULL`).all();
            oldTimeAllocations.forEach(ta => {
                const matchedTeam = addedTeams.find(at => at.matchId === at.team_id);
                const matchedDeliverable = addedDeliverables.find(d => d.matchId === ta.deliverable_id);
                if(matchedTeam || matchedDeliverable) {
                    timeAllocationInsert.run([ta.startDate, ta.endDate, now, ta.uuid, ta.partialTime, matchedTeam ? matchedTeam.newId : ta.team_id, matchedDeliverable ? matchedDeliverable.newId : ta.deliverable_id, ta.discipline_id]);
                }
            });

            return changes;
        });

        return insertDeliverables(deliverables);
    }
    //#endregion

    //#region Generate Progress Tracker Delta Report
    /**
     * Compares deltas between two dates and sends a markdown report document to the Discord channel the command message originated from
     * @param argv The available arguments [TODO]
     * @param msg The command message
     * @param db The database connection
     */
    private static async generateProgressTrackerDeltaReport(argv: Array<string>, msg: Message, db: Database) {
        let start: number = null;
        let end: number = null;

        const args = require('minimist')(argv.slice(1));

        // select closest existing date prior to or on entered date
        if(args['e'] && args['e'] !== true) {
            if(Number(args['e'])) {
                const dbEnd = db.prepare(`SELECT addedDate FROM deliverable_diff WHERE addedDate <= ${GeneralHelpers.convertDateToTime(args['e'].toString())} ORDER BY addedDate DESC LIMIT 1`).get();
                end = dbEnd && dbEnd.addedDate;
            }
        } else {
            const dbEnd = db.prepare("SELECT addedDate FROM deliverable_diff ORDER BY addedDate DESC LIMIT 1").get();
            end = dbEnd && dbEnd.addedDate;
        }

        if(args['s'] && args['s'] !== true) {
            if(Number(args['s'])) {
                const dbStart = db.prepare(`SELECT addedDate FROM deliverable_diff WHERE addedDate <= ${GeneralHelpers.convertDateToTime(args['s'].toString())} ORDER BY addedDate DESC LIMIT 1`).get();
                start = dbStart && dbStart.addedDate;
            }
        } else {
            // determine date immediately before end
            const dbStart = end && db.prepare(`SELECT addedDate FROM deliverable_diff WHERE addedDate < ${end} ORDER BY addedDate DESC LIMIT 1`).get();
            start = dbStart && dbStart.addedDate;
        }
        
        if(!start || !end || start >= end ) {
            return msg.channel.send('Invalid timespan or insufficient data to generate report.').catch(console.error);
        }

        msg.channel.send('Calculating differences between roadmaps...').catch(console.error);

        const first = this.buildDeliverables(start, db, true);
        const last = this.buildDeliverables(end, db, true);
        const dbRemovedDeliverables = db.prepare(`SELECT uuid, title FROM deliverable_diff WHERE addedDate <= ${start} AND startDate IS NULL AND endDate IS NULL GROUP BY uuid`).all();

        let messages = [];
        const compareTime = Date.now();
        let changes = {added: 0, removed: 0, updated: 0, readded: 0};

        messages.push(`# Progress Tracker Delta #  \n### ${last.length} deliverables listed | ${new Date(start).toDateString()} => ${new Date(end).toDateString()} ###  \n`);
        messages.push('---  \n\n');

        const removedDeliverables = first.filter(f => !last.some(l => l.uuid === f.uuid || (f.title && f.title === l.title && !f.title.includes("Unannounced"))));
        if(removedDeliverables.length) {
            messages.push(`## [${removedDeliverables.length}] deliverable(s) *removed*: ##  \n`);
            removedDeliverables.forEach(d => {
                const dMatch = first.find(f => d.uuid === f.uuid || (f.title && f.title === d.title && !f.title.includes("Unannounced"))); // guaranteed to exist if we know it has been removed
                messages.push(he.unescape(`### **${d.title.trim()}** ###  \n`.toString()));
                messages.push(`*Last scheduled from ${new Date(d.startDate).toDateString()} to ${new Date(d.endDate).toDateString()}*  \n`);
                messages.push(he.unescape(GeneralHelpers.shortenText(`${d.description}  \n`)));

                if(dMatch.teams) {
                    const freedTeams = dMatch.teams.map(t => t.title);
                    messages.push(GeneralHelpers.shortenText(`* The following team(s) have been freed up: ${_.uniq(freedTeams).join(', ')}  \n`));
                    // TODO - Add how many devs have been freed up for each discipline
                }

                messages = [...messages, ...this.generateCardImage(d, dMatch, args['publish'])];
                // removed deliverable implies associated time allocations were removed; no description necessary
                changes.removed++;
            });
            messages.push('---  \n\n');
        }

        const newDeliverables = last.filter(l => !first.some(f => l.uuid === f.uuid || (l.title && l.title === f.title && !l.title.includes("Unannounced"))));
        if(newDeliverables.length) {
            messages.push(`## [${newDeliverables.length}] deliverable(s) *added*: ##  \n`);
            newDeliverables.forEach(d => {
                const dMatch = dbRemovedDeliverables.find((dd) => dd.uuid === d.uuid || (d.title && dd.title === d.title && !d.title.includes("Unannounced")));
                if(dMatch) {
                    changes.readded++;
                }
                const start = new Date(d.startDate).toDateString();
                const end = new Date(d.endDate).toDateString();
                if(args['publish']) {
                    messages.push(he.unescape(`### **<a href="https://${RSINetwork.rsi}/roadmap/progress-tracker/deliverables/${d.slug}" target="_blank">${d.title.trim()}</a>**${dMatch?` (returning!)`:''} ###  \n`.toString()));
                } else {
                    messages.push(he.unescape(`### **${d.title.trim()}**${dMatch?` (returning!)`:''} ###  \n`.toString()));
                }
                messages.push(he.unescape(`*${start} => ${end}*  \n`.toString()));
                messages.push(he.unescape(GeneralHelpers.shortenText(`${d.description}  \n`)));

                if(d.teams) {
                    messages.push(`The following team(s) were assigned:  \n`);
                    d.teams.forEach(t => {
                        const starting = t.timeAllocations.sort((a,b) => a.startDate - b.startDate)[0];
                        const startingText = starting.startDate < compareTime ? `began work` : `will begin work`;
                        messages.push(`* ${t.title} ${startingText} ${new Date(starting.startDate).toDateString()}  \n`);

                        const disciplineSchedules = _._(t.timeAllocations).groupBy('title').map(v=>v).value();
                        disciplineSchedules.forEach(ds => {
                            let partTime = 0;
                            let fullTime = 0;
                            let timeSpan = 0;
                            ds.filter(v => d.updateDate < v.endDate).forEach(ds => {
                                if(ds.partialTime) {
                                    partTime++;
                                } else {
                                    fullTime++;
                                }
                                timeSpan += ds.endDate - ds.startDate;
                            });
                            const load = Math.round(100 * this.calculateTaskLoad({numberOfMembers: ds[0].numberOfMembers, fullTime: fullTime, partTime: partTime, startDate: 0, endDate: timeSpan}));
                            const tasks = partTime + fullTime;
                            const devs = 'dev' + (ds.numberOfMembers>1?'s':'');
                            if(tasks) {
                                messages.push(`x${ds[0].numberOfMembers} ${ds[0].title} ${devs} with ${tasks} tasks (${load}% load)  \n`); 
                            } else {
                                messages.push(`x${ds[0].numberOfMembers} ${ds[0].title} ${devs} previously completed all available tasks  \n`); 
                            }
                        });
                    });
                    messages.push('  \n');
                }

                messages = [...messages, ...this.generateCardImage(d, dMatch, args['publish'])];
                changes.added++;
            });
            messages.push('---  \n\n');
        }

        const remainingDeliverables = first.filter(f => !removedDeliverables.some(r => r.uuid === f.uuid) || !newDeliverables.some(n => n.uuid === f.uuid));
        let updatedDeliverables = [];
        if(remainingDeliverables.length) {
            let updatedMessages = [];
            remainingDeliverables.forEach(f => {
                const l = last.find(x => x.uuid === f.uuid || (f.title && x.title === f.title && !f.title.includes("Unannounced")));
                const d = diff.getDiff(f, l).filter((df) => df.op === 'update');
                if(d.length && l) {
                    const dChanges = d.map(x => ({op: x.op, change: x.path && x.path[0], val: x.val}));
                    const dChangesToDetect = ['endDate','startDate', 'title', 'description', 'teams'];
                    
                    let update = [];
                    if(dChanges.some(p => dChangesToDetect.some(detect => detect.includes(p.change.toString())))) {
                        if(dChanges.some(p => p.change === 'startDate')) {
                            const oldDate = new Date(f.startDate);
                            const oldDateText = oldDate.toDateString();
                            const newDate = new Date(l.startDate);
                            const newDateText = newDate.toDateString();

                            let updateText = "";
                            if(Date.parse(oldDateText) < compareTime && Date.parse(newDateText) < compareTime) {
                                updateText = "been corrected"; // shift in either direction is most likely a time allocation correction
                            } else if(newDate < oldDate) {
                                updateText = "moved closer";
                            } else if(oldDate < newDate) {
                                updateText = "pushed back";
                            }

                            update.push(`\* Start date has ${updateText} from ${oldDateText} to ${newDateText}  \n`);
                        }
                        if(dChanges.some(p => p.change === 'endDate')) {
                            const oldDate = new Date(f.endDate);
                            const oldDateText = oldDate.toDateString();
                            const newDate = new Date(l.endDate);
                            const newDateText = newDate.toDateString();

                            let updateText = "";
                            if(compareTime < Date.parse(oldDateText) && Date.parse(newDateText) < compareTime) {
                                updateText = "moved earlier (time allocation removal(s) likely)  \n"; // likely team time allocation was removed, but could have finished early
                            } else if(oldDate < newDate) {
                                updateText = "been extended";
                            } else if(newDate < oldDate) {
                                updateText = "moved closer";
                            }

                            update.push(`\* End date has ${updateText} from ${oldDateText} to ${newDateText}  \n`);
                        }

                        if(dChanges.some(p => p.change === 'title')) {
                            update.push(GeneralHelpers.shortenText(`\* Title has been updated from "${f.title}" to "${l.title}"`));
                        }
                        if(dChanges.some(p => p.change === 'description')) {
                            update.push(GeneralHelpers.shortenText(`\* Description has been updated from  \n"${f.description}"  \nto  \n"${l.description}"`));
                        }

                        let teamsChanged = false;
                        if(dChanges.some(p => p.change === 'teams')) {
                            const teamChangesToDetect = ['startDate', 'endDate', 'timeAllocations']; // possible for start and end to remain the same while having shifting time allocations
                            l.teams.forEach(lt => { // added/modified
                                teamsChanged = true;
                                //const lDiff = lt.endDate - lt.startDate; // total timespan for team; irrelevant for deliverable based deltas
                                const assignedStart = lt.timeAllocations && lt.timeAllocations.length ? _.minBy(lt.timeAllocations, 'startDate').startDate : 0;
                                const assignedEnd = lt.timeAllocations && lt.timeAllocations.length ? _.maxBy(lt.timeAllocations, 'endDate').endDate : 0;
                                //const lDiff = assignedEnd - assignedStart; // total timespan for team, adjusted for assigned time allocations; 
                                const lDiff = GeneralHelpers.mergeDateRanges(lt.timeAllocations).map(dr => dr.endDate - dr.startDate).reduce((partialSum, a) => partialSum + a, 0);

                                const teamMatch = f.teams.find(ft => ft.slug === lt.slug);
                                if(teamMatch) {
                                    const teamChanges = diff.getDiff(lt, teamMatch).filter((df) => df.op === 'update');
                                    const tChanges = teamChanges.map(x => ({op: x.op, change: x.path && x.path[0], val: x.val})).filter(tc => teamChangesToDetect.some(td => td.includes(tc.change.toString())));
                                        
                                    if(tChanges.length) {
                                        //const tmDiff = teamMatch.endDate - teamMatch.startDate; // total timespan for team; irrelavant for deliverable based deltas
                                        const tmAssignedStart = teamMatch.timeAllocations && teamMatch.timeAllocations.length ? _.minBy(teamMatch.timeAllocations, 'startDate').startDate : 0;
                                        const tmAssignedEnd = teamMatch.timeAllocations && teamMatch.timeAllocations.length ? _.maxBy(teamMatch.timeAllocations, 'endDate').endDate : 0;
                                        //const tmDiff = tmAssignedEnd - tmAssignedStart; // total timespan for team, adjusted for assigned time allocations; 
                                        const tmDiff = GeneralHelpers.mergeDateRanges(teamMatch.timeAllocations).map(dr => dr.endDate - dr.startDate).reduce((partialSum, a) => partialSum + a, 0);
                                        const timeDiff = lDiff - tmDiff; // positive is more work
                                        const dayDiff = GeneralHelpers.convertMillisecondsToDays(timeDiff);
                                        const tmDaysRemaining = GeneralHelpers.convertMillisecondsToDays(tmAssignedEnd - (compareTime < tmAssignedStart ? tmAssignedStart : compareTime));
                                        const extraDays = dayDiff - tmDaysRemaining;
                                        const displayDays = extraDays < 0 ? dayDiff : tmDaysRemaining;
    
                                        if(dayDiff) {
                                            if(tmDiff === 0 && dayDiff > 0) {
                                                update.push(`* ${lt.title} was assigned, ${assignedStart < compareTime ? 'revealing' : 'adding'} ${displayDays} days of work  \n`);
                                            } else if(displayDays > 0) {
                                                update.push(`* ${lt.title} ${timeDiff > 0 ? "added":"freed up"} ${displayDays} days of work  \n`);
                                            }
                                        }
                                    }
                                } else {
                                    const daysRemaining = GeneralHelpers.convertMillisecondsToDays(assignedEnd - compareTime);
                                    const dayDiff = GeneralHelpers.convertMillisecondsToDays(lDiff);
                                    //const displayDays = daysRemaining > dayDiff ? dayDiff : daysRemaining;
                                    const extraDays = dayDiff - daysRemaining;
                                    update.push(`* ${lt.title} was assigned, ${assignedStart < compareTime ? 'revealing' : 'adding'} ${extraDays < 0 ? dayDiff : extraDays} days of work  \n`);
                                }
                            });

                            // removed teams
                            if(f.teams) {
                                const removedTeams = f.teams.filter(f => l.teams && !l.teams.some(l => l.slug === f.slug));
                                removedTeams.forEach(rt => {
                                    const rtDiff = rt.endDate - rt.startDate;
                                    const dayDiff = GeneralHelpers.convertMillisecondsToDays(rtDiff);
                                    update.push(`* ${rt.title} was removed, freeing up ${dayDiff} days of work  \n`);
                                });
                            }
                        }

                        if(update.length) {
                            const title = f.title === 'Unannounced' ? `${f.title} (${f.description})` : f.title;
                            if(args['publish']) {
                                update.splice(0,0,`### **<a href="https://${RSINetwork.rsi}/roadmap/progress-tracker/deliverables/${l.slug}" target="_blank">${title.trim()}</a>** ###  \n`);
                            } else {
                                update.splice(0,0,`### **${title.trim()}** ###  \n`);
                            }
                            
                            update.splice(1,0,`*${new Date(l.startDate).toDateString()} => ${new Date(l.endDate).toDateString()}*  \n`);

                            updatedMessages.push(he.unescape(update.join('') + '  \n'));
                        
                            if(f.card && !l.card) {
                                updatedMessages.push("#### Removed from release roadmap! ####  \n  \n");
                            } else if(l.card) {
                                updatedMessages = [...updatedMessages, ...this.generateCardImage(l, f, args['publish'])];
                            }
                            
                            updatedDeliverables.push(f);
                            changes.updated++;
                        }
                    }
                }
            });
            messages.push(`## [${updatedDeliverables.length}] deliverable(s) *updated*: ##  \n`);
            messages = messages.concat(updatedMessages);
            messages.push(`## [${remainingDeliverables.length - updatedDeliverables.length}] deliverable(s) *unchanged* ##  \n\n`);
            
            const readdedText = changes.readded ? ` (with ${changes.readded} returning)` : "";
            messages.splice(1,0,GeneralHelpers.shortenText(`There were ${changes.updated} modifications, ${changes.removed} removals, and ${changes.added} additions${readdedText} in this update.  \n`));

            // TODO - tldr here

            if(args['publish']) {
                messages = [...GeneralHelpers.generateFrontmatter(GeneralHelpers.convertTimeToHyphenatedDate(compareTime), this.ReportCategoryEnum.Delta, "Progress Tracker Delta"), ...messages];
            }
        }

        GeneralHelpers.sendTextMessageFile(messages, `${GeneralHelpers.convertTimeToHyphenatedDate(end)}-Progress-Tracker-Delta.md`, msg);
    }

    /**
     * Generates a markdown card image for display along with detected changes. Github size limit for images is 5 MB
     * @param deliverable The deliverable to display a card image for
     * @param oldDeliverable The previous deliverable to check for deltas against
     * @param publish Whether to generate additional YAML
     * @returns The image messages
     */
     private static generateCardImage(deliverable: any, oldDeliverable: any, publish: boolean = false): string[] {
        const messages = [];
        if(deliverable.card) {
            if(oldDeliverable.card) {
                const d = diff.getDiff(deliverable.card, oldDeliverable.card).filter((df) => df.op === 'update');
                if(d.length) {
                    const dChanges = d.map(x => ({op: x.op, change: x.path && x.path[0], val: x.val}));
                    const changesToDetect = ['title','description', 'category', 'release_title'];
                    dChanges.filter(p => changesToDetect.some(detect => detect.includes(p.change.toString()))).forEach(dc => {
                        messages.push(GeneralHelpers.shortenText(`* Release ${_.capitalize(dc.change)} has been changed from  \n'${oldDeliverable.card[dc.change]}'  \nto '${deliverable.card[dc.change]}'  \n`));
                    });
                }
            }

            if(publish) {
                const cardImage = deliverable.card.thumbnail.includes(RSINetwork.rsi) ? deliverable.card.thumbnail : `https://${RSINetwork.rsi}${deliverable.card.thumbnail}`;
                messages.push(`![](${cardImage})  \n`);
                messages.push(`<sup>Release ${deliverable.card.release_title}</sup>  \n\n`);
            } else {
                messages.push(`Release ${deliverable.card.release_title}  \n\n`);
            }
        }
        return messages;
    }
    //#endregion

    /**
     * Looks up raw data for a given time period or date [TODO]
     * @param argv The available arguments
     * @param msg The command message
     * @param db The database connection
     */
    private static lookup(argv: Array<string>, msg: Message, db: Database) {
        const args = require('minimist')(argv);
        if('t' in args) {
            let compareTime = null;
            if(args['t'] === 'teams') {
                compareTime = Date.now();
            } else {
                compareTime = GeneralHelpers.convertDateToTime(args['t']);
            }

            if(Number(compareTime)) {
                const deliverables = this.buildDeliverables(compareTime, db, true);
                const messages = this.generateScheduledDeliverablesReport(compareTime, deliverables, db, args['publish']);
                if(!messages.length) {
                    msg.channel.send("Insufficient data to generate report.");
                    return;
                }
                GeneralHelpers.sendTextMessageFile(messages, `${GeneralHelpers.convertTimeToHyphenatedDate(compareTime)}-Scheduled-Deliverables.md`, msg);
            } else {
                msg.channel.send("Invalid date for Sprint Report lookup. Use YYYYMMDD format.");
            }
        }

        // // only show tasks that complete in the future
        // if('n' in argv) {
        //     const now = Date.now();
        //     deliverables = deliverables.filter(d => new Date(d.endDate).getTime() > now);
        // }

        // // only show tasks that have expired or been completed
        // if('o' in argv) {
        //     const now = Date.now();
        //     deliverables = deliverables.filter(d => new Date(d.endDate).getTime() <= now);
        // }

        // // sort by soonest expiring
        // if('e' in argv) {
        //     deliverables.sort((a,b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime() || new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
        // }
    }

    //#region Generate Schedule Deliverables Report
    /**
     * Generates a report for the items being worked on at the given time
     * @param compareTime The time to lookup time allocations with
     * @param deliverables The list of deliverables to generate the report for
     * @param db The database connection
     * @param publish Whether or not to generate the report online display
     * @returns The report lines array
     */
    private static generateScheduledDeliverablesReport(compareTime: number, deliverables: any[], db: Database, publish: boolean = false): string[] {
        let messages = [];
        const scheduledTasks = db.prepare(`SELECT *, MAX(addedDate) FROM timeAllocation_diff WHERE startDate <= ${compareTime} AND ${compareTime} <= endDate AND deliverable_id IN (${deliverables.map(l => l.id).toString()}) GROUP BY uuid`).all();
        const currentTasks = _.uniqBy(scheduledTasks.map(t => ({did: t.deliverable_id})), 'did');

        if(!currentTasks.length) {
            return messages;
        }

        const groupedTasks = _.groupBy(scheduledTasks, 'deliverable_id');
        const teamTasks = _._(scheduledTasks).groupBy('team_id').map(v=>v).value();

        let deltas = this.getDeliverableDeltaDateList(db);
        let past = deltas[0] > _.uniq(deliverables.map(d => d.addedDate))[0]; // check if most recent deliverable in list is less recent than the most recent possible deliverable

        if(publish) {
            messages = GeneralHelpers.generateFrontmatter(GeneralHelpers.convertTimeToHyphenatedDate(compareTime), this.ReportCategoryEnum.Teams, "Scheduled Deliverables");
        }

        messages.push(`## There ${past?'were':'are currently'} ${currentTasks.length} scheduled deliverables being worked on by ${teamTasks.length} teams ##  \n`);
        messages.push("---  \n");

        const introDesc = 'This report lists the actively assigned deliverables and the associated teams, along with the number of developers assigned to '+
            'each time period. Deliverable time allocations are often staggered over their total lifespan and have multiple devs in the same department working in parallel, but their allocations are obviously not going to be equal.';
        const outroDesc = "The load calculation is an approximation based on the sum of the part-time and full-time tasks (averaged at 80 hours to complete a piece) divided by the team capacity (with a focus factor of 60%) over the given time period. "+
            "Without exact hourly estimates for each task, a more accurate assessment doesn't seem likely, so interpret the load as a given dev group's general utilization on a deliverable.";
        if(publish) {
            messages.push(`### ${introDesc} For a better look at this, clicking the team name (or one of the completion dates listed below it) will display a rendering of the current waterfall chart iteration. This chart provides `+
            `an overview of the schedule breakdown of each team in week long segments.<br/><br/>${outroDesc} ###  \n`);
        } else {
            messages.push(GeneralHelpers.shortenText(`${introDesc}  \n${outroDesc}`));
        }

        messages.push("---  \n");

        deliverables.filter(l => currentTasks.some(ct => ct.did === l.id)).forEach((d) => {
            const schedules = groupedTasks[d.id];
            const teams = _.orderBy(d.teams.filter(mt => schedules.some(s => s.team_id === mt.id)), [d => d.title.toLowerCase()], ['asc']);
            if(publish) {
                let projectIcons = '';
                d.project_ids.split(',').forEach(p => {
                    projectIcons += `<span><img src="https://${RSINetwork.rsi}${RSINetwork.ProjectImages[p]}"/></span>`;
                });
                messages.push(`  \n### **<a href="https://${RSINetwork.rsi}/roadmap/progress-tracker/deliverables/${d.slug}" target="_blank">${d.title.trim()}</a>** ${projectIcons} ###  \n`);
            } else {
                messages.push(`  \n### **${d.title.trim()}** [${d.project_ids.replace(',', ', ')}] ###  \n`);
            }
            
            teams.forEach((mt, i) => {
                messages.push((i ? '  \n' : '') + this.generateWaterfallChart(mt, compareTime, publish));
            });
        });

        return messages;
    }

    /**
     * Generates a text based waterfall chart displaying weeks
     * @param team The team
     * @param compareTime The time to generate the chart around (yearly)
     * @param publish Whether to generate the waterfall chart or just the details
     * @returns A text based, collapsible waterfall chart text block
     */
     private static generateWaterfallChart(team: any, compareTime, publish: boolean = false): string {
        const timelines = [];
        let waterfalls = [];

        timelines.push(publish ? `<details><summary>${team.title.trim()} ${timelines}  \n` : `* ${team.title.trim()}  \n`);

        const disciplineSchedules = _._(team.timeAllocations).groupBy((time) => time.disciplineUuid).map(v=>v).value();
        disciplineSchedules.forEach(s => { // generate mergeDateRanges for each discipline
            // I believe it is likely that because there can be more duplicate time entries for a given scheduled period than there are assigned members means each represent
            // a different task in the same two week sprint period. Some have been marked as needing full time attention and others part time.
            let sprints = _._(s).groupBy((time) => [time.startDate, time.endDate].join()).map(v=>v).value();
            sprints = sprints.map(sprint => ({fullTime: _.countBy(sprint, t => t.partialTime > 0).true ?? 0, partTime: _.countBy(sprint, t => t.partialTime > 0).false ?? 0, ...sprint[0]}));
            const mergedSchedules = GeneralHelpers.mergeDateRanges(sprints);
            const matchMergedSchedules = mergedSchedules.filter(ms => ms.startDate <= compareTime && compareTime <= ms.endDate);
            
            if(publish) {
                const time = new Date(compareTime);
                const firstOfYear = new Date(time.getFullYear(), 0, 1); // 01/01
                const thisWeek = GeneralHelpers.getWeek(time, firstOfYear);
                let newWaterfall = [];
                
                sprints.forEach((sprint) => {
                    let start  = new Date(sprint.startDate);
                    start = start < firstOfYear ? firstOfYear : start;
                    const end = new Date(sprint.endDate);
                    if(end < start) {
                        return;
                    }
                    if(!newWaterfall.length) {
                        newWaterfall = new Array(52).fill('..');
                    }
                    const weightedTimePercent = this.calculateTaskLoad(sprint);
                    const startWeek = GeneralHelpers.getWeek(start, firstOfYear);
                    const endWeek = GeneralHelpers.getWeek(end, firstOfYear);
                    const fill = weightedTimePercent > 1 ? '==' : '~~'; // Thought about using ≈, but its too easily confused with =
                    const period = new Array(endWeek + 1 - startWeek).fill(fill);
                    newWaterfall.splice(startWeek - 1, period.length, ...period);
                });
                if(newWaterfall.length) {
                    const weekType = newWaterfall[thisWeek - 1];
                    const day = time.getDay();

                    if(weekType === '==') {
                        newWaterfall.splice(thisWeek - 1, 1, day<5?'|=':'=|');
                    } else if((weekType === '~~')){
                        newWaterfall.splice(thisWeek - 1, 1, day<5?'|~':'~|');
                    } else {
                        newWaterfall.splice(thisWeek - 1, 1, day<5?'|.':'.|');
                    }

                    waterfalls.push(newWaterfall.join(''));
                }
                
                // descriptions for the current weeks in descending order of display
                timelines.push(`<ul>`);
                matchMergedSchedules.forEach((ms, msi) => {
                    const fullTimePercent = Math.round(this.calculateTaskLoad(ms) * 100);
                    const tasks = ms.fullTime + ms.partTime;
                    timelines.push(`<li>${ms.numberOfMembers}x ${ms.title} dev${ms.numberOfMembers>1?'s':''} working on ${tasks} task${tasks>1?'s':''} (${fullTimePercent}% load)`+
                        ` thru ${new Date(ms.endDate).toDateString()}</li>`);
                });
                timelines.push(`</ul>`);
            } else {
                matchMergedSchedules.forEach(ms => {
                    const fullTimePercent = Math.round(this.calculateTaskLoad(ms) * 100);
                    const tasks = ms.fullTime + ms.partTime;
                    timelines.push(` - ${ms.numberOfMembers}x ${ms.title} dev${ms.numberOfMembers>1?'s':''} working on ${tasks} task${tasks>1?'s':''} (${fullTimePercent}% load)`+
                        ` thru ${new Date(ms.endDate).toDateString()}  \n`);
                });
            }
        });

        return timelines.join('') + (publish ? `</summary><p>${waterfalls.join('<br>')}</p></details>` : '');
    }
    //#endregion

    /**
     * Converts database model(s) to json and exports them
     * @param argv The argument array (-t YYYYMMDD for specific one or --all for all)
     * @param msg The command message
     * @param db The database connection
     * @param discord Whether to send the file to discord or to save locally
     */
    private static async exportJson(argv: any[], msg: Message, db: Database, discord: boolean = false) {
        let exportDates: number[] = [];

        const args = require('minimist')(argv.slice(1));
            
        if(args['all'] === true) {
            exportDates = this.getDeliverableDeltaDateList(db);
        } else {
            // select closest existing date prior to or on entered date
            if(args['t'] && args['t'] !== true) {
                if(Number(args['t'])) {
                    const dbEnd = db.prepare(`SELECT addedDate FROM deliverable_diff WHERE addedDate <= ${GeneralHelpers.convertDateToTime(args['t'].toString())} ORDER BY addedDate DESC LIMIT 1`).get();
                    exportDates.push(dbEnd && dbEnd.addedDate);
                }
            } else {
                const dbEnd = db.prepare("SELECT addedDate FROM deliverable_diff ORDER BY addedDate DESC LIMIT 1").get();
                exportDates.push(dbEnd && dbEnd.addedDate);
            }

            if(!exportDates.length) {
                return msg.channel.send('Invalid timespan or insufficient data to generate report.').catch(console.error);
            }
        }

        await exportDates.forEach(async (exportDate) => {
            const deliverablesToExport = this.buildDeliverables(exportDate, db, true);
            deliverablesToExport.forEach(d => { // strip added fields
                delete(d.id);
                delete(d.card_id);
                delete(d.addedDate);
                delete(d.max);
                d.startDate = GeneralHelpers.convertTimeToFullDate(d.startDate);
                d.endDate = GeneralHelpers.convertTimeToFullDate(d.endDate);
                d.updateDate = GeneralHelpers.convertTimeToFullDate(d.updateDate);
                d.description = _.escape(d.description);
                d.title = _.escape(d.title);
                d.projects = [];
                d.project_ids.split(',').forEach(pi => {
                    d.projects.push({title: pi === 'SC' ? 'Star Citizen' : 'Squadron 42'});
                });
                delete(d.project_ids);
                if(d.card) {
                    d.card.id = d.card.tid;
                    d.card.updateDate = GeneralHelpers.convertTimeToFullDate(d.card.updateDate);
                    d.card.release = {
                        id: d.card.release_id,
                        title: d.card.release_title
                    };
                    delete(d.card.addedDate);
                    delete(d.card.tid);
                } else {
                    d.card = null;
                }

                if(d.teams) {
                    d.teams.forEach(t => {
                        delete(t.addedDate);
                        delete(t.id);
                        t.startDate = GeneralHelpers.convertTimeToFullDate(t.startDate);
                        t.endDate = GeneralHelpers.convertTimeToFullDate(t.endDate);
                        if(t.timeAllocations) {
                            t.timeAllocations.forEach(ta => {
                                ta.startDate = GeneralHelpers.convertTimeToFullDate(ta.startDate);
                                ta.endDate = GeneralHelpers.convertTimeToFullDate(ta.endDate);
                                ta.discipline = {
                                    title: ta.title,
                                    numberOfMembers: ta.numberOfMembers,
                                    uuid: ta.disciplineUuid
                                };
                                delete(ta.title);
                                delete(ta.addedDate);
                                delete(ta.id);
                                delete(ta.deliverable_id);
                                delete(ta.discipline_id);
                                delete(ta.team_id);
                                delete(ta.numberOfMembers);
                                delete(ta.disciplineUuid);
                                delete(ta['MAX(ta.addedDate)']);
                            });
                        }
                    });
                }
            });

            const filename = `${GeneralHelpers.convertTimeToHyphenatedDate(exportDate)}.json`;
            const json = JSON.stringify(deliverablesToExport);

            if(discord && this.AllowExportSnapshotsToDiscord) {
                await GeneralHelpers.sendTextMessageFile([json], filename, msg);
            } else {
                // save to local directory
                await fs.writeFile(path.join(__dirname, '..', 'data_exports', filename), json, () => {});
            }
        });
        
        msg.channel.send('Export complete.');
    }

    //#region Helper methods
    /**
     * Approximates the developer load for the given task numbers
     * @param schedule The developer discipline schedule (numberOfMembers, fullTime, partTime, endDate, startDate)
     * @returns The weighted average of full-time load
     */
    private static calculateTaskLoad(schedule: any): number {
        const timespan = GeneralHelpers.convertMillisecondsToDays(schedule.endDate - schedule.startDate);
        const teamCapacity = schedule.numberOfMembers * 0.6 * timespan * 8; // focus factor
        const scheduleLoad = (schedule.fullTime + schedule.partTime * .5) * 80; // guess at 80 hours per task on average
        //const taskMemberRatio = (schedule.fullTime + schedule.partTime * .5) / schedule.numberOfMembers;
        //const weightedTaskAverage = (schedule.fullTime + schedule.partTime * .5) / (schedule.fullTime + schedule.partTime);
        return scheduleLoad / teamCapacity;
    }

    /**
     * Provides the list of available delta update dates
     * @param db The database connection
     * @returns The distinct list of delta update dates in descending order
     */
    private static getDeliverableDeltaDateList(db: Database): number[] {
        return db.prepare("SELECT DISTINCT addedDate FROM deliverable_diff ORDER BY addedDate DESC").all().map(d => d.addedDate);
    }

    /**
     * Looks up deliverables for a given date and connects the associated teams, cards, and time allocations
     * @param date The date to lookup data for
     * @param db The database connection
     * @param alphabetize Whether to alphabetize the list
     * @returns The list of deliverables
     */
    private static buildDeliverables(date: number, db: Database, alphabetize: boolean = false): any[] {
        let dbDeliverables = db.prepare(`SELECT *, MAX(addedDate) as max FROM deliverable_diff WHERE addedDate <= ${date} GROUP BY uuid ORDER BY addedDate DESC`).all();
        let removedDeliverables = dbDeliverables.filter(d => d.startDate === null && d.endDate === null);
        dbDeliverables = dbDeliverables.filter(d => !removedDeliverables.some(r => r.uuid === d.uuid || (r.title && r.title === d.title && !r.title.includes("Unannounced"))));
        const announcedDeliverables = _._(dbDeliverables.filter(d => d.title && !d.title.includes("Unannounced"))).groupBy('title').map(d => d[0]).value();
        const unAnnouncedDeliverables = dbDeliverables.filter(d => d.title && d.title.includes("Unannounced"));
        dbDeliverables = [...announcedDeliverables, ...unAnnouncedDeliverables];
        
        const cardIds = dbDeliverables.filter((dd) => dd.card_id).map((dd) => dd.card_id).toString();
        const dbCards = db.prepare(`SELECT * FROM card_diff WHERE id IN (${cardIds})`).all();

        const deliverableIds = dbDeliverables.map((dd) => dd.id).toString();
        
        const dbDeliverableTeams = db.prepare(`SELECT * FROM team_diff WHERE id IN (SELECT team_id FROM deliverable_teams WHERE deliverable_id IN (${deliverableIds})) ORDER BY addedDate DESC`).all();
        const deliverableTeams = _.groupBy(db.prepare(`SELECT * FROM deliverable_teams WHERE deliverable_id IN (${deliverableIds})`).all(), 'deliverable_id');
        
        let dbTimeAllocations = db.prepare(`SELECT *, MAX(ta.addedDate), ta.id AS time_id, ta.uuid AS time_uuid, ta.addedDate AS time_added FROM timeAllocation_diff AS ta JOIN discipline_diff AS di ON di.id = ta.discipline_id`+
        ` WHERE deliverable_id IN (${deliverableIds}) AND team_id IN (${dbDeliverableTeams.map(z => z.id).join(',')}) AND partialTime IS NOT NULL GROUP BY ta.uuid`).all();
        let teamIds = dbTimeAllocations.map(z => z.team_id).filter((value, index, self) => self.indexOf(value) === index);
        dbTimeAllocations.forEach(ta => {
            ta.disciplineUuid = ta.uuid;
            ta.id = ta.time_id;
            ta.uuid = ta.time_uuid;
            ta.addedDate = ta.time_added;
            delete(ta.time_id);
            delete(ta.time_uuid);
            delete(ta.time_added);
        });
        dbTimeAllocations = _.groupBy(dbTimeAllocations, 'deliverable_id');

        dbDeliverables.forEach((d) => {
            d.card = dbCards.find((c) => c.id === d.card_id);
            const timeAllocations = _.groupBy(dbTimeAllocations[d.id], 'team_id');
            const teams = dbDeliverableTeams.filter(t => deliverableTeams[d.id] && deliverableTeams[d.id].some(tid => t.id === tid.team_id));
            teams.forEach((t) => {
                if(!d.teams) {
                    d.teams = [];
                }
                let team = _.clone(t);
                team.timeAllocations = timeAllocations[t.id] && timeAllocations[t.id].filter(z => z.startDate && z.endDate);
                d.teams.push(team);
            });
        });

        return alphabetize ? _.orderBy(dbDeliverables, [d => d.title.toLowerCase()], ['asc']) : dbDeliverables;
    };
    //#endregion
}