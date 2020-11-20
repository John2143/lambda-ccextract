let aws = require("aws-sdk");
let cp = require("child_process");
let s3 = new aws.S3();
let fs = require("fs");

const Bucket = "john2143.lambdatest";

async function getStream(filename){
    return await s3.getObject({
        Bucket,
        Key: filename,
    }).createReadStream();
}

let shres = [];

//ergonomic shell wrapper
async function shell(name, ...args){
    return await shelladv(name, args, null);
}

function finishBufs(bufs){
    return Buffer.concat(bufs);
}

//scuffed shell wrappers
async function shelladv(name, args, stdintext, stdofunc){
    let p = cp.spawn(name, args);

    let stdoutProm = true;
    if(stdofunc){
        stdoutProm = stdofunc(p.stdout);
    }

    if(stdintext){
        let totalwritten = 0;
        stdintext.on("data", d => {
            p.stdin.write(d);
            totalwritten += d.length;
        });
        stdintext.on("end", d => {
            p.stdin.end()
            console.log("some thing done MB", totalwritten / 1024 / 1024);
        });
    }

    let ebufs = [];

    p.stderr.on("data", d => ebufs.push(d));

    return await new Promise(resolve => {
        p.on("error", code => {
            ebufs = finishBufs(ebufs);
            shres.push({code, ebufs});
            resolve(ebufs)
        });

        p.on("exit", code => {
            ebufs = finishBufs(ebufs);
            shres.push({code, ebufs});
            resolve(stdoutProm);
        });
    });
}

exports.handler = async (event) => {
    //Assume that ccex-static exists in the source bucket, and that its
    //staticly linked (see docker gizmotronic/ccextractor for build)
    let executable = await getStream("ccex-static");
    executable.pipe(fs.createWriteStream("/tmp/cx"));
    await new Promise(resolve => executable.on("end", resolve))
    await shell("chmod", "+x", "/tmp/cx");

    let ccargs = [
        "-bi", "-stdin", //stream from stdin
        "--buffersize", "1M", //smaller buffer seems to work better
        "--stream", "10", //put in stream mode: wont end on file end
        "-out=webvtt", //hardcode vtt for now, change to loop over input someday
        "-debug",
        "--no_progress_bar",
        "-stdout",
    ];

    //avoid ETXTBSY on executable from chmod not finishing
    await new Promise(resolve => setTimeout(resolve, 50));

    let videoStream = (await getStream(event.in));
    await shelladv("/tmp/cx", ccargs, videoStream, stdout => {
        return new Promise((resolve, reject) => {
            console.log("starting upload");
            //when stdout ends, the upload should end too.
            //use this to detect when to end the program
            s3.upload({
                Bucket, Key: event.out, Body: stdout,
            }, (err, data) => {
                console.log("upload done", err);
                if(err){
                    reject();
                }else{
                    resolve();
                }
            });
        })
    });

    return {
        statusCode: 200,
        //show stderr of all shell commands as result
        shres: shres.map(x => {
            x.ebufs = x.ebufs.toString("utf-8");
            return x
        }),
    };
};

