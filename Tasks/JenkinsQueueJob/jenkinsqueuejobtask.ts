// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

/// <reference path="../../definitions/node.d.ts"/>
/// <reference path="../../definitions/vsts-task-lib.d.ts" />
/// <reference path="../../definitions/shelljs.d.ts"/>

import tl = require('vsts-task-lib/task');
import fs = require('fs');
import path = require('path');
import shell = require('shelljs');

// node js modules
var request = require('request');

var serverEndpoint = tl.getInput('serverEndpoint', true);
var serverEndpointUrl = tl.getEndpointUrl(serverEndpoint, false);
tl.debug('serverEndpointUrl=' + serverEndpointUrl);

var serverEndpointAuth = tl.getEndpointAuthorization(serverEndpoint, false);
var username = serverEndpointAuth['parameters']['username'];
var password = serverEndpointAuth['parameters']['password'];

var jobName = tl.getInput('jobName', true);

var captureConsole = tl.getBoolInput('captureConsole', true);
var pollInterval = 5000; // five seconds is what the Jenkins Web UI uses

// capturePipeline is only possible if captureConsole mode is enabled
var capturePipeline = captureConsole ? tl.getBoolInput('capturePipeline', true) : false;

var parameterizedJob = tl.getBoolInput('parameterizedJob', true);

var jobQueueUrl = addUrlSegment(serverEndpointUrl, '/job/' + jobName);
jobQueueUrl += (parameterizedJob) ? '/buildWithParameters?delay=0sec' : '/build?delay=0sec';
tl.debug('jobQueueUrl=' + jobQueueUrl);

function addUrlSegment(baseUrl: string, segment: string): string {
    var resultUrl = null;
    if (baseUrl.endsWith('/') && segment.startsWith('/')) {
        resultUrl = baseUrl + segment.slice(1);
    } else if (baseUrl.endsWith('/') || segment.startsWith('/')) {
        resultUrl = baseUrl + segment;
    } else {
        resultUrl = baseUrl + '/' + segment;
    }
    return resultUrl;
}

function failError(err): void {
    fail(err);
}

function failReturnCode(httpResponse, message: string): void {
    var fullMessage = message +
        '\nHttpResponse.statusCode=' + httpResponse.statusCode +
        '\nHttpResponse.statusMessage=' + httpResponse.statusMessage +
        '\nHttpResponse=\n' + JSON.stringify(httpResponse);
    fail(fullMessage);
}

function fail(message: string): void {
    tl.debug('fail');
    tl.debug(message);
    tl.setResult(tl.TaskResult.Failed, message);
    tl.exit(1);
}

enum JobState {
    New,       // 0
    Locating,  // 1
    Streaming, // 2
    Finishing, // 3
    Done,      // 4
    Joined,    // 5
    Queued,    // 6
    Lost       // 7
}

class Job {
    parentJob: Job; // if this job is a pipelined job, its parent that started it.
    childrenJobs: Job[] = []; // any pipelined jobs
    joinedJob: Job // if this job is joined, the main job that is running
    initialSearchBuildNumber: number; // the intial, most likely build number for child jobs
    nextSearchBuildNumber: number; // the next build number to check
    searchDirection: number = -1; // negative means search backwards, positive means search forwards

    /**
     * running -> done              :normal path for root level job
     * unknown -> running -> done   :normal path for pipelined job
     * unknown -> joined            :alternate path for pipelined job (when several jobs kick off the same job that has not yet been queued)
     * unknown -> lost              :when a pipelined job can not be found after searching.
     */
    state: JobState = JobState.New;
    taskUrl: string; // URL for the job definition
    executableUrl: string; // URL for the executing job instance
    executableNumber: number;
    name: string;
    jobConsole: string = "";
    jobConsoleOffset: number = 0;
    jobConsoleEnabled: boolean = false;

    working: boolean = false;
    workDelay: number = 0;

    parsedTaskBody; // set during state New
    parsedCauses; // set prior to Streaming
    parsedExecutionResult; // set during state Finishing

    constructor(parent: Job, taskUrl: string, executableUrl: string, executableNumber: number, name: string) {
        this.parentJob = parent;
        this.taskUrl = taskUrl;
        this.executableUrl = executableUrl;
        this.executableNumber = executableNumber;
        this.name = name;
        if (this.parentJob != null) {
            this.parentJob.childrenJobs.push(this); // do this last since parentJob is already in the queue
        }
        this.debug('created');
    }

    doWork() {
        if (this.working) { // return if already working
            return;
        } else {
            this.working = true;
            setTimeout(() => {
                if (this.state == JobState.New) {
                    if (this.parentJob == null) { // root job, can skip Locating
                        if (captureConsole) {
                            this.enableConsole();
                            this.setStreaming([], this.executableNumber); // jump to Streaming
                        } else {
                            this.changeState(JobState.Queued); // also skip Streaming and jump to Finishing
                        }
                    } else {
                        this.changeState(JobState.Locating); // pipeline jobs
                    }
                    this.initializeNewJob();
                } else if (this.state == JobState.Locating) {
                    locateChildExecutionBuildNumber(this);
                } else if (JobState.Streaming == this.state) {
                    streamConsole(this);
                } else if (JobState.Finishing == this.state) {
                    finish(this);
                } else {
                    // usually do not get here, but this can happen if another job caused this one to be joined
                    this.stopWork(0, null);
                }
            }, this.workDelay);
        }
    }

    stopWork(delay: number, jobState: JobState) {
        if (jobState && jobState != this.state) {
            this.changeState(jobState);
            if (!this.isActive()) {
                jobQueue.flushJobConsolesSafely();
            }
            if(jobState == JobState.Done){
                console.log('Done   :'+this);
            }
        }
        this.workDelay = delay;
        this.working = false;
    }

    changeState(newState: JobState) {
        var oldState = this.state;
        this.state = newState;
        if (oldState != newState) {
            this.debug('state changed from: ' + oldState);
            var validStateChange = false;
            if (oldState == JobState.New) {
                if (newState == JobState.Streaming) {
                    validStateChange = (this.parentJob == null && captureConsole);
                } else if (newState == JobState.Queued) {
                    validStateChange = (this.parentJob == null && !captureConsole);
                } else {
                    validStateChange = (newState == JobState.Locating || newState == JobState.Joined);
                }
            } else if (oldState == JobState.Locating) {
                validStateChange = (newState == JobState.Joined || newState == JobState.Streaming);
            } else if (oldState == JobState.Streaming) {
                validStateChange = (newState == JobState.Finishing);
            } else if (oldState == JobState.Finishing) {
                validStateChange = (newState == JobState.Done);
            } else if (oldState == JobState.Joined || oldState == JobState.Done) {
                validStateChange = false; // these are terminal states
            }
            if (!validStateChange) {
                console.log('Warning invalid state change from: ' + oldState + ' ' + this);
            }
        }
    }

    getState(): JobState {
        return this.state;
    }

    isActive(): boolean {
        return this.state == JobState.New ||
            this.state == JobState.Locating ||
            this.state == JobState.Streaming ||
            this.state == JobState.Finishing
    }

    setStreaming(causes, executableNumber: number): void {
        this.parsedCauses = causes;
        this.executableNumber = executableNumber;
        this.executableUrl = addUrlSegment(this.taskUrl, this.executableNumber.toString());
        this.changeState(JobState.Streaming);

        this.consoleLog('******************************************************************************\n');
        this.consoleLog('Jenkins job started: ' + this.name + '\n');
        this.consoleLog(this.executableUrl + '\n');
        this.consoleLog('******************************************************************************\n');

        if (jobQueue.findActiveConsoleJob() == null) {
            //console.log('Jenkins job pending: ' + this.executableUrl);
        }

        //join all other siblings to this same job
        var joinedCauses = causes.length > 1 ? causes.slice(1) : [];
        for (var i in joinedCauses) {
            var cause = joinedCauses[i];
            var causeJob = jobQueue.findJob(cause.upstreamProject, cause.upstreamBuild);
            if (causeJob != null) { // if it's null, then the cause was triggered outside this pipeline
                for (var c in causeJob.childrenJobs) {
                    var child: Job = causeJob.childrenJobs[c];
                    if (child.name == this.name) {
                        child.setJoined(this);
                        console.log('JoinedA:' + child);
                    }
                }
            }
        }
    }

    setParsedExecutionResult(parsedExecutionResult) {
        this.parsedExecutionResult = parsedExecutionResult;
        this.consoleLog('******************************************************************************\n');
        this.consoleLog('Jenkins job finished: ' + this.name + '\n');
        this.consoleLog(this.executableUrl + '\n');
        this.consoleLog('******************************************************************************\n');
    }

    setJoined(joinedJob: Job): void {
        tl.debug(this + '.setJoined(' + joinedJob + ')');
        this.joinedJob = joinedJob;
        this.changeState(JobState.Joined);
    }

    getResultString(): string {
        if (this.state == JobState.Queued) {
            return 'Queued';
        } else if (this.state == JobState.Done) {
            var resultCode = this.parsedExecutionResult.result.toUpperCase();
            // codes map to fields in http://hudson-ci.org/javadoc/hudson/model/Result.html
            if (resultCode == 'SUCCESS') {
                return 'Success';
            } else if (resultCode == 'UNSTABLE') {
                return 'Unstable';
            } else if (resultCode == 'FAILURE') {
                return 'Failure';
            } else if (resultCode == 'NOT_BUILT') {
                return 'Not built';
            } else if (resultCode == 'ABORTED') {
                return 'Aborted';
            } else {
                return resultCode;
            }
        } else return 'Unknown';
    }

    getTaskResult(finalJobState: JobState): number {
        if (finalJobState == JobState.Queued) {
            return tl.TaskResult.Succeeded;
        } else if (finalJobState == JobState.Done) {
            var resultCode = this.parsedExecutionResult.result.toUpperCase();
            if (resultCode == "SUCCESS" || resultCode == 'UNSTABLE') {
                return tl.TaskResult.Succeeded;
            } else {
                return tl.TaskResult.Failed;
            }
        }
        return tl.TaskResult.Failed;
    }

    refreshJobTask(job, callback) {
        var apiTaskUrl = addUrlSegment(this.taskUrl, "/api/json");
        this.debug('getting job task URL:' + apiTaskUrl);
        return request.get({ url: apiTaskUrl }, function requestCallBack(err, httpResponse, body) {
            if (err) {
                failError(err);
            } else if (httpResponse.statusCode != 200) {
                failReturnCode(httpResponse, 'Unable to retrieve job: ' + this.name);
            } else {
                job.parsedTaskBody = JSON.parse(body);
                job.debug("parsedBody for: " + apiTaskUrl + ": " + JSON.stringify(job.parsedTaskBody));
                callback();
            }
        });
    }

    initializeNewJob() {
        var job = this;
        this.refreshJobTask(this, function callback() {
            if (job.parsedTaskBody.inQueue) { // if it's in the queue, start checking with the next build number
                job.initialSearchBuildNumber = job.parsedTaskBody.nextBuildNumber;
            } else { // otherwise, check with the last build number.
                job.initialSearchBuildNumber = job.parsedTaskBody.lastBuild.number;
            }
            job.nextSearchBuildNumber = job.initialSearchBuildNumber;
            job.stopWork(pollInterval, job.state);
        });
    }

    enableConsole() {
        if (captureConsole) {
            if (!this.jobConsoleEnabled) {
                if (this.jobConsole != "") { // flush any queued output
                    //console.log(this.jobConsole);
                }
                this.jobConsoleEnabled = true;
            }
        }
    }

    isConsoleEnabled() {
        return this.jobConsoleEnabled;
    }

    consoleLog(message: string) {
        if (this.jobConsoleEnabled) {
            //only log it if the console is enabled.
            //console.log(message);
        }
        this.jobConsole += message;
    }

    debug(message: string) {
        var fullMessage = this.toString() + ' debug: ' + message;
        tl.debug(fullMessage);
    }

    toString() {
        var fullMessage = '(' + this.state + ':' + this.name + ':' + this.executableNumber;
        if (this.parentJob != null) {
            fullMessage += ', p:' + this.parentJob;
        }
        if (this.joinedJob != null) {
            fullMessage += ', j:' + this.joinedJob;
        }
        fullMessage += ')';
        return fullMessage;
    }
}

class JobQueue {
    jobs: Job[] = [];

    constructor(rootJob: Job) {
        this.jobs.push(rootJob);
        this.start();
    }

    intervalId: NodeJS.Timer;
    intervalMillis: number = 10;

    start(): void {
        tl.debug('jobQueue.start()');
        this.intervalId = setInterval(() => {
            var activeJobs: Job[] = this.getActiveJobs();
            if (activeJobs.length == 0) {
                this.stop();
            } else {
                activeJobs.forEach((job) => {
                    job.doWork();
                });
                this.flushJobConsolesSafely();
            }
        }, this.intervalMillis);
    }

    stop(): void {
        tl.debug('jobQueue.stop()');
        clearInterval(this.intervalId);
        this.flushJobConsolesSafely();
        var message: string = null;
        if (capturePipeline) {
            message = 'Jenkins pipeline complete';
        } else if (captureConsole) {
            message = 'Jenkins job complete';
        } else {
            message = 'Jenkins job queued';
        }
        this.writeFinalMarkdown();
        tl.setResult(tl.TaskResult.Succeeded, message);
        tl.exit(0);
    }

    queue(job: Job): void {
        this.jobs.push(job);
    }

    getActiveJobs(): Job[] {
        var activeJobs: Job[] = [];

        for (var i in this.jobs) {
            var job = this.jobs[i];
            if (job.isActive()) {
                activeJobs.push(job);
            }
        }

        return activeJobs;
    }

    flushJobConsolesSafely(): void {
        if (this.findActiveConsoleJob() == null) { //nothing is currently writing to the console
            var streamingJobs: Job[] = [];
            var addedToConsole: boolean = false;
            for (var i in this.jobs) {
                var job = this.jobs[i];
                if (job.getState() == JobState.Done) {
                    if (!job.isConsoleEnabled()) {
                        job.enableConsole(); // flush the finished ones
                        addedToConsole = true;
                    }
                } else if (job.getState() == JobState.Streaming || job.getState() == JobState.Finishing) {
                    streamingJobs.push(job); // these are the ones that could be running
                }
            }
            // finally, if there is only one remaining, it is safe to enable its console
            if (streamingJobs.length == 1) {
                streamingJobs[0].enableConsole();
            } else if (addedToConsole) {
                for (var i in streamingJobs) {
                    var job = streamingJobs[i];
                    //console.log('Jenkins job pending: ' + job.executableUrl);
                }
            }
        }
    }

    /**
     * If there is a job currently writing to the console, find it.
     */
    findActiveConsoleJob(): Job {
        var activeJobs: Job[] = this.getActiveJobs();
        for (var i in activeJobs) {
            var job = activeJobs[i];
            if (job.isConsoleEnabled()) {
                return job;
            }
        }
        return null;
    }

    findJob(name: string, executableNumber: number): Job {
        for (var i in this.jobs) {
            var job = this.jobs[i];
            if (job.name == name && job.executableNumber == executableNumber) {
                return job;
            }
        }
        return null;
    }

    writeFinalMarkdown() {
        tl.debug('writing summary markdown');
        var rootJob: Job = this.jobs[0];
        var tempDir = shell.tempdir();
        var linkMarkdownFile = path.join(tempDir, 'JenkinsJob_' + rootJob.name + '_' + rootJob.executableNumber + '.md');
        tl.debug('markdown location: ' + linkMarkdownFile);
        var tab: string = "  ";
        var paddingTab: number = 4;
        var markdownContents = walkHierarchy(rootJob, "", 0);

        function walkHierarchy(job: Job, indent: string, padding: number): string {
            var jobContents = indent + '<ul style="padding-left:' + padding + '">\n';

            // if this job was joined to another follow that one instead
            job = job.getState() == JobState.Joined ? job.joinedJob : job;
            var jobState: JobState = job.getState();

            if (jobState == JobState.Done || jobState == JobState.Queued) {
                jobContents += indent + '[' + job.name + ' #' + job.executableNumber + '](' + job.executableUrl + ') ' + job.getResultString() + '<br>\n';
            } else {
                console.log('Warning, still in active state: ' + job);
            }

            var childContents = "";
            for (var i in job.childrenJobs) {
                var child = job.childrenJobs[i];
                childContents += walkHierarchy(child, indent + tab, padding + paddingTab);
            }

            return jobContents + childContents + indent + '</ul>\n';
        }

        fs.writeFile(linkMarkdownFile, markdownContents, function callback(err) {
            tl.debug('writeFinalMarkdown().writeFile().callback()');

            if (err) {
                //don't fail the build -- there just won't be a link
                console.log('Error creating link to Jenkins job: ' + err);
            } else {
                console.log('##vso[task.addattachment type=Distributedtask.Core.Summary;name=Jenkins Results;]' + linkMarkdownFile);
            }

        });

    }
}

var jobQueue: JobQueue;

function joinAllPossible() {
    for (var i in jobQueue.jobs) {
        var job = jobQueue.jobs[i];
        joinIfPossible(job);
    }
}

function joinIfPossible(job: Job): boolean {
    if (job.getState() != JobState.Locating && job.getState() != JobState.Lost) {
        return true; // already joined
    }
    for (var i in jobQueue.jobs) {
        var aJob = jobQueue.jobs[i];
        if (aJob.parentJob == null || aJob == job || aJob.name != job.name) {
            continue;  // can't join with root, self, or a job with a different name
        }
        if (aJob.getState() == JobState.Streaming || aJob.getState() == JobState.Done) {
            // can only join with something that is running or already ran

            // search causes after the first one (since the first determines the master job)
            var joinedCauses = aJob.parsedCauses.length > 1 ? aJob.parsedCauses.slice(1) : [];
            for (var j in joinedCauses) {
                var cause = joinedCauses[j];
                var aCauseJob = jobQueue.findJob(cause.upstreamProject, cause.upstreamBuild);
                if (aCauseJob == job.parentJob) {
                    //finally, if the cause is the job's parent, then it should be joined
                    job.setJoined(aJob);
                    console.log('JoinedB:' + job);
                    return true;
                }
            }
        }
    }
    return false;
}


/**
 * Search for a pipelined job starting with a best guess for the build number, and a direction to search.
 * First the search is done backwards and terminates when either finding the specified job, or the job's
 * timestamp is earlier than the timestamp of the parent job that queued it.  Then the restarts from the
 * intial start point and searches forward until the job is found, or a 404 is reached and no more jobs
 * are queued.  At any point, the search also ends if the job is joined to another job.
 */
function locateChildExecutionBuildNumber(job: Job) {
    tl.debug('locateChildExecutionBuildNumber()');
    if (job.getState() != JobState.Locating || joinIfPossible(job)) {
        // another callback joined or started this job
        job.stopWork(0, job.state);
        return;
    }
    var url = addUrlSegment(job.taskUrl, job.nextSearchBuildNumber + "/api/json");
    job.debug('pipeline, locating child execution URL:' + url);
    request.get({ url: url }, function requestCallback(err, httpResponse, body) {
        tl.debug('locateChildExecutionBuildNumber().requestCallback()');
        if (job.getState() != JobState.Locating || joinIfPossible(job)) {
            // another callback joined or started this job
            job.stopWork(0, job.state);
        } else if (err) {
            failError(err);
        } else if (httpResponse.statusCode == 404) {
            // This job doesn't exist -- do we expect it to in the near future because it has been queued?
            job.debug('404 for: ' + job.name + ':' + job.nextSearchBuildNumber);
            job.debug('checking if it is in the queue');
            job.refreshJobTask(job, function refreshJobTaskCallback() {
                if (job.getState() != JobState.Locating || joinIfPossible(job)) {
                    // another callback joined or started this job
                    job.stopWork(0, job.state);
                } else if (job.parsedTaskBody.inQueue || job.parsedTaskBody.lastCompletedBuild >= job.nextSearchBuildNumber) {
                    //see if it's in the queue, or maybe it just ran right after we first checked
                    job.debug('job has been queued, continue searching');
                    job.stopWork(pollInterval, job.state);
                } else {
                    console.log('restarting search for:' + job);
                    job.nextSearchBuildNumber = job.initialSearchBuildNumber;
                    job.searchDirection = -1;
                    job.stopWork(pollInterval, job.state);
                    //job.stopWork(pollInterval, JobState.Lost);
                }
            });
        } else if (httpResponse.statusCode != 200) {
            failReturnCode(httpResponse, 'Job pipeline tracking failed to read downstream project');
        } else {
            var parsedBody = JSON.parse(body);
            job.debug("parsedBody for: " + url + ": " + JSON.stringify(parsedBody));

            /**
             * This is the list of all reasons for this job execution to be running.  
             * Jenkins may 'join' several pipelined jobs so all will be listed here.
             * e.g. suppose A -> C and B -> C.  If both A & B scheduled C around the same time before C actually started, 
             * Jenkins will join these requests and only run C once.
             * So, for all jobs being tracked (within this code), the first one in the list is the one that is actually running,
             * all others are considered joined and will not be tracked further.
             */
            var causes = parsedBody.actions[0].causes;
            var firstCauseJob = jobQueue.findJob(causes[0].upstreamProject, causes[0].upstreamBuild);
            if (firstCauseJob != null) {
                //The job we found is part of the pipeline!
                if (firstCauseJob == job.parentJob) {
                    // this one.  mark it running, and start grabbing the console, and join others to it
                    job.setStreaming(causes, job.nextSearchBuildNumber);
                    job.stopWork(pollInterval, job.state);
                    return;
                } else {
                    // not this one, so, find it!
                    for (var i in firstCauseJob.childrenJobs) {
                        var otherJob = firstCauseJob.childrenJobs[i];
                        if (otherJob.name == job.name) {
                            //found it -- so kick it off to run instead (which will may or may not cause this one to join with it)
                            if (otherJob.getState() != JobState.Streaming && otherJob.getState() != JobState.Done) {
                                otherJob.setStreaming(causes, job.nextSearchBuildNumber);
                            }
                        }
                    }
                    if (job.getState() == JobState.Joined) {
                        // great, this job joined with the other one.
                        job.stopWork(0, job.state);
                        return;
                    }

                }
            }
            // need to keep searching
            job.debug('Search failed for: ' + job.name + ':' + job.nextSearchBuildNumber + ' triggered by :' + job.parentJob.name + ':' + job.parentJob.parsedExecutionResult.number);
            if (job.searchDirection < 0) { // search backwards
                if (parsedBody.timestamp <= job.parentJob.parsedExecutionResult.timestamp || job.nextSearchBuildNumber == 1) {
                    // we already searched backwards as far as possible, 
                    // so start searching forwards from the begining
                    job.debug('changing search direction');
                    job.nextSearchBuildNumber = job.initialSearchBuildNumber + 1;
                    job.searchDirection = 1;
                } else { // search backwards one
                    job.debug('searching back one');
                    job.nextSearchBuildNumber--;
                }
            } else { // search forwards one
                job.debug('searching forward one');
                job.nextSearchBuildNumber++;
            }
            job.stopWork(pollInterval, job.state);
        }
    });
}

/**
 * Streams the Jenkins console.
 * 
 * JobState = Streaming, transition to Finishing possible.
 */
function streamConsole(job: Job) {
    var fullUrl = addUrlSegment(job.executableUrl, '/logText/progressiveText/?start=' + job.jobConsoleOffset);
    job.debug('Tracking progress of job URL: ' + fullUrl);
    request.get({ url: fullUrl }, function requestCallback(err, httpResponse, body) {
        tl.debug('streamConsole().requestCallback()');
        if (err) {
            failError(err);
        } else if (httpResponse.statusCode != 200) {
            failReturnCode(httpResponse, 'Job progress tracking failed to read job progress');
        } else {
            job.consoleLog(body); // redirect Jenkins console to task console
            var xMoreData = httpResponse.headers['x-more-data'];
            if (xMoreData && xMoreData == 'true') {
                var offset = httpResponse.headers['x-text-size'];
                job.jobConsoleOffset = offset;
                job.stopWork(pollInterval, job.state);
            } else { // no more console, move to Finishing
                job.stopWork(0, JobState.Finishing);
            }
        }
    });
}
/**
 * Checks the success of the job
 * 
 * JobState = Finishing, transition to Done or Queued possible
 */
function finish(job: Job) {
    tl.debug('finish()');
    if (!captureConsole) { // transition to Queued
        job.stopWork(0, JobState.Queued);
    } else { // stay in Finishing, or eventually go to Done
        var resultUrl = addUrlSegment(job.executableUrl, 'api/json');
        job.debug('Tracking completion status of job: ' + resultUrl);
        request.get({ url: resultUrl }, function requestCallback(err, httpResponse, body) {
            tl.debug('finish().requestCallback()');
            if (err) {
                fail(err);
            } else if (httpResponse.statusCode != 200) {
                failReturnCode(httpResponse, 'Job progress tracking failed to read job result');
            } else {
                var parsedBody = JSON.parse(body);
                job.debug("parsedBody for: " + resultUrl + ": " + JSON.stringify(parsedBody));
                if (parsedBody.result) {
                    job.setParsedExecutionResult(parsedBody);
                    if (capturePipeline) {
                        var downstreamProjects = job.parsedTaskBody.downstreamProjects;
                        // each of these runs in parallel
                        downstreamProjects.forEach((project) => {
                            var child: Job = new Job(job, project.url, null, -1, project.name);
                            jobQueue.queue(child);
                        });
                    }
                    job.stopWork(0, JobState.Done);
                } else {
                    // result not updated yet -- keep trying
                    job.stopWork(pollInterval, job.state);
                }
            }
        });
    }
}

function trackJobQueued(queueUri: string) {
    tl.debug('trackJobQueued()');
    tl.debug('Tracking progress of job queue: ' + queueUri);
    request.get({ url: queueUri }, function requestCallback(err, httpResponse, body) {
        tl.debug('trackJobQueued().requestCallback()');
        if (err) {
            failError(err);
        } else if (httpResponse.statusCode != 200) {
            failReturnCode(httpResponse, 'Job progress tracking failed to read job queue');
        } else {
            var parsedBody = JSON.parse(body);
            tl.debug("parsedBody for: " + queueUri + ": " + JSON.stringify(parsedBody));

            // canceled is spelled wrong in the body with 2 Ls (checking correct spelling also in case they fix it)
            if (parsedBody.cancelled || parsedBody.canceled) {
                tl.setResult(tl.TaskResult.Failed, 'Jenkins job canceled.');
                tl.exit(1);
            }
            var executable = parsedBody.executable;
            if (!executable) {
                // job has not actually been queued yet, keep checking
                setTimeout(function () {
                    trackJobQueued(queueUri);
                }, pollInterval);
            } else {
                var rootJob: Job = new Job(null, parsedBody.task.url, parsedBody.executable.url, parsedBody.executable.number, parsedBody.task.name);
                jobQueue = new JobQueue(rootJob);
            }
        }
    });
}


/**
 * Supported parameter types: boolean, string, choice, password
 * 
 * - If a parameter is not defined by Jenkins it is fine to pass it anyway
 * - Anything passed to a boolean parameter other than 'true' (case insenstive) becomes false.
 * - Invalid choice parameters result in a 500 response.
 * 
 */
function parseJobParameters() {
    var formData = {};
    var jobParameters: string[] = tl.getDelimitedInput('jobParameters', '\n', false);
    for (var i = 0; i < jobParameters.length; i++) {
        var paramLine = jobParameters[i];
        var splitIndex = paramLine.indexOf('=');
        if (splitIndex <= 0) { // either no paramValue (-1), or no paramName (0)
            fail('Job parameters should be specified as "parameterName=parameterValue" with one name, value pair per line. Invalid parameter line: ' + paramLine);
        }
        var paramName = paramLine.substr(0, splitIndex);
        var paramValue = paramLine.slice(splitIndex + 1);
        formData[paramName] = paramValue;
    }
    return formData;
}

var initialPostData = parameterizedJob ?
    { url: jobQueueUrl, formData: parseJobParameters() } :
    { url: jobQueueUrl };

tl.debug('initialPostData = ' + JSON.stringify(initialPostData));

/**
 * This post starts the process by kicking off the job and then: 
 *    |
 *    |---------------            
 *    V              | not queued yet            
 * trackJobQueued() --  
 *    |
 * captureConsole --no--> createLinkAndFinish()   
 *    |
 *    |----------------------
 *    V                     | more stuff in console  
 * captureJenkinsConsole() --    
 *    |
 *    |-------------
 *    V            | keep checking until something
 * checkSuccess() -- 
 *    |
 *    V
 * createLinkAndFinish()
 */
request.post(initialPostData, function optionalCallback(err, httpResponse, body) {
    if (err) {
        fail(err);
    } else if (httpResponse.statusCode != 201) {
        failReturnCode(httpResponse, 'Job creation failed.');
    } else {
        console.log('Jenkins job queued');
        var queueUri = addUrlSegment(httpResponse.headers.location, 'api/json');
        trackJobQueued(queueUri);
    }
}).auth(username, password, true);